/** Atlas pieces retain all triangle representations and material-group offsets in one geometry. */
import { BufferAttribute, BufferGeometry } from 'three'
import { intoRect, SWATCH, SWATCH_LUM } from './atlas.ts'
import type { Piece } from './bake.ts'

/** Atlas UV of one vertex of a piece (its own UVs mapped onto its swatch). */
function atlasUv(p: Piece, u: number, v: number): [number, number] {
  const sw = p.swatch ?? 'plain'
  if (sw === 'atlas') {
    return [u, v]
  }
  const c = (x: number) => Math.min(1, Math.max(0, x))
  return intoRect(SWATCH[sw], c(u), c(v))
}

/** Luminance the shader normalises a piece's texels by (0 = multiply). */
function pieceLum(p: Piece): number {
  const sw = p.swatch ?? 'plain'
  return sw === 'atlas' ? (p.lum ?? 0) : SWATCH_LUM[sw]
}

/** Plain merged geometry (position, normal, color, uv, styMat, styLum, index). */
export function mergePieces(pieces: readonly Piece[]): BufferGeometry {
  let verts = 0
  let tris = 0
  for (const p of pieces) {
    verts += p.geo.getAttribute('position').count
    tris += p.geo.index?.count ?? p.geo.getAttribute('position').count
  }
  const outP = new Float32Array(verts * 3)
  const outN = new Float32Array(verts * 3)
  const outC = new Float32Array(verts * 3)
  const outS = new Float32Array(verts * 2)
  const outU = new Float32Array(verts * 2)
  const outL = new Float32Array(verts)
  const idx = new Uint32Array(tris)
  const groups: { start: number; count: number; materialIndex: number }[] = []
  const grouped = pieces.some((piece) => piece.geo.groups.length > 0)
  let vo = 0
  let io = 0
  for (const p of pieces) {
    const g = p.geo
    if (!g.getAttribute('normal')) {
      g.computeVertexNormals()
    }
    const pa = g.getAttribute('position')
    const na = g.getAttribute('normal')
    const ca = g.getAttribute('color')
    const ua = g.getAttribute('uv')
    const lum = pieceLum(p)
    for (let k = 0; k < pa.count; k++) {
      outU.set(atlasUv(p, ua ? ua.getX(k) : 0.5, ua ? ua.getY(k) : 0.5), (vo + k) * 2)
      outL[vo + k] = lum
      const o = (vo + k) * 3
      outP.set([pa.getX(k), pa.getY(k), pa.getZ(k)], o)
      outN.set([na.getX(k), na.getY(k), na.getZ(k)], o)
      outC.set(ca ? [ca.getX(k), ca.getY(k), ca.getZ(k)] : [1, 1, 1], o)
      outS.set([p.roughnessAt?.[k] ?? p.roughness, p.rim], (vo + k) * 2)
    }
    if (grouped) {
      appendGroups(g, groups, io)
    }
    io = appendIndices(g, idx, vo, io)
    vo += pa.count
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(outP, 3))
  out.setAttribute('normal', new BufferAttribute(outN, 3))
  out.setAttribute('color', new BufferAttribute(outC, 3))
  out.setAttribute('uv', new BufferAttribute(outU, 2))
  out.setAttribute('styMat', new BufferAttribute(outS, 2))
  out.setAttribute('styLum', new BufferAttribute(outL, 1))
  out.setIndex(new BufferAttribute(verts > 65_535 ? idx : Uint16Array.from(idx), 1))
  for (const group of groups) {
    out.addGroup(group.start, group.count, group.materialIndex)
  }
  return out
}

function appendIndices(
  g: BufferGeometry,
  output: Uint32Array,
  vertexOffset: number,
  indexOffset: number,
): number {
  const count = g.index?.count ?? g.getAttribute('position').count
  for (let i = 0; i < count; i++) {
    output[indexOffset + i] = vertexOffset + (g.index?.getX(i) ?? i)
  }
  return indexOffset + count
}

function appendGroups(
  g: BufferGeometry,
  groups: { start: number; count: number; materialIndex: number }[],
  offset: number,
): void {
  const source =
    g.groups.length > 0
      ? g.groups
      : [{ start: 0, count: g.index?.count ?? g.getAttribute('position').count, materialIndex: 0 }]
  for (const group of source) {
    groups.push({
      start: offset + group.start,
      count: group.count,
      materialIndex: group.materialIndex ?? 0,
    })
  }
}
