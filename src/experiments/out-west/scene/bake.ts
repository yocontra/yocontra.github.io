// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh/isSkinnedMesh flags are typed `true` on the cast type; testing them is the runtime type check
/**
 * Baking a dressed character into ONE skinned mesh (one draw call, one
 * skeleton palette of only the bones that carry weight): the posed body
 * meshes and every fitted garment become a single geometry with per-vertex
 * colour and per-vertex surface response (roughness, rim), bound in the pose
 * it was dressed in.
 */
import {
  type Bone,
  BufferAttribute,
  BufferGeometry,
  type Material,
  Matrix4,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three'
import { intoRect, SWATCH, SWATCH_LUM, type Swatch } from './atlas.ts'
import type { Body, WeightFn } from './fit.ts'

/**
 * One piece of the final character: root-space geometry (position, normal,
 * colour, index) authored in the current pose, its surface response, and how
 * it is skinned.
 */
export interface Piece {
  /** Root-space geometry: position, normal, colour (the tint), index, and `uv` when it has one. */
  geo: BufferGeometry
  /** The source material's name, for body parts (Hair, Skin, Shirt...). */
  name?: string
  /** Roughness multiplier on the atlas (plain swatch: the roughness itself). */
  roughness: number
  rim: number
  /**
   * Where its UVs point: `atlas` (a body part, already in atlas space) or a fabric swatch its
   * 0..1 UVs are mapped onto (procedural garments; plain when it has none).
   */
  swatch?: Swatch | 'atlas'
  /** Mean luminance of the main fabric when recoloured (0 = multiply by the tint). */
  lum?: number
  /** Per-vertex weights (garments); or `skin`, precomputed indices into `Body.bones` (the body). */
  weights?: WeightFn
  skin?: { index: Uint16Array; weight: Float32Array }
}

/** A rigid piece riding one bone. */
export const onBone =
  (bone: Bone): WeightFn =>
  () => [[bone, 1]]

const firstMaterial = (m: Mesh['material']): MeshStandardMaterial =>
  (Array.isArray(m) ? m[0] : m) as MeshStandardMaterial

const tmpM = new Matrix4()

/** Linear-blend skinning matrix of vertex `k` (bone world × inverse bind, weighted) into `out`. */
function blendBones(sm: SkinnedMesh, k: number, out: Matrix4): Matrix4 {
  const si = sm.geometry.getAttribute('skinIndex')
  const sw = sm.geometry.getAttribute('skinWeight')
  out.elements.fill(0)
  for (let c = 0; c < 4; c++) {
    const w = sw.getComponent(k, c)
    const li = si.getComponent(k, c)
    const bone = sm.skeleton.bones[li]
    const ib = sm.skeleton.boneInverses[li]
    if (w > 0 && bone && ib) {
      tmpM.multiplyMatrices(bone.matrixWorld, ib)
      for (let q = 0; q < 16; q++) {
        out.elements[q] = (out.elements[q] ?? 0) + (tmpM.elements[q] ?? 0) * w
      }
    }
  }
  return out
}

/** The posed body meshes under `model` as pieces (posed positions and normals in `space`). */
export function bodyPieces(model: Object3D, space: Object3D, body: Body): Piece[] {
  const out: Piece[] = []
  const index = new Map<Bone, number>(body.bones.map((b, i) => [b, i]))
  const inv = space.matrixWorld.clone().invert()
  const m = new Matrix4()
  const acc = new Matrix4()
  const v = new Vector3()
  const n = new Vector3()
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass per vertex (skin, pose, attributes) kept together to avoid re-walking the buffers
  model.traverse((o) => {
    const sm = o as SkinnedMesh
    if (!sm.isSkinnedMesh) {
      return
    }
    const mat = firstMaterial(sm.material)
    const g = sm.geometry
    const pos = g.getAttribute('position')
    const nrm = g.getAttribute('normal')
    const si = g.getAttribute('skinIndex')
    const sw = g.getAttribute('skinWeight')
    const count = pos.count
    const outP = new Float32Array(count * 3)
    const outN = new Float32Array(count * 3)
    const outC = new Float32Array(count * 3)
    const uvA = g.getAttribute('uv')
    const outI = new Uint16Array(count * 4)
    const outW = new Float32Array(count * 4)
    const toSpace = inv.clone().multiply(sm.matrixWorld).multiply(sm.bindMatrixInverse)
    const local = sm.skeleton.bones.map((b) => index.get(b) ?? 0)
    for (let k = 0; k < count; k++) {
      blendBones(sm, k, acc)
      for (let c = 0; c < 4; c++) {
        outI[k * 4 + c] = local[si.getComponent(k, c)] ?? 0
        outW[k * 4 + c] = sw.getComponent(k, c)
      }
      m.multiplyMatrices(toSpace, acc).multiply(sm.bindMatrix)
      v.fromBufferAttribute(pos, k).applyMatrix4(m)
      outP.set([v.x, v.y, v.z], k * 3)
      if (nrm) {
        n.fromBufferAttribute(nrm, k).transformDirection(m)
        outN.set([n.x, n.y, n.z], k * 3)
      }
      outC.set([mat.color.r, mat.color.g, mat.color.b], k * 3)
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(outP, 3))
    geo.setAttribute('normal', new BufferAttribute(outN, 3))
    geo.setAttribute('color', new BufferAttribute(outC, 3))
    if (uvA) {
      const uv = new Float32Array(count * 2)
      for (let k = 0; k < count; k++) {
        uv[k * 2] = uvA.getX(k)
        uv[k * 2 + 1] = uvA.getY(k)
      }
      geo.setAttribute('uv', new BufferAttribute(uv, 2))
    }
    geo.setIndex(g.index ? Array.from(g.index.array) : Array.from({ length: count }, (_, i) => i))
    if (!nrm) {
      geo.computeVertexNormals()
    }
    const recolor = mat.userData.recolor === true
    out.push({
      geo,
      name: mat.name,
      // textured body parts take their roughness from the atlas
      roughness: uvA ? 1 : mat.roughness,
      rim: (mat.userData.rim as number | undefined) ?? 1,
      skin: { index: outI, weight: outW },
      swatch: uvA ? 'atlas' : 'plain',
      lum: recolor ? ((mat.userData.lum as number | undefined) ?? 0) : 0,
    })
  })
  return out
}

/** Pieces from plain procedural meshes under `obj`, coloured by their material. */
export function meshPieces(obj: Object3D, space: Object3D, weights?: WeightFn): Piece[] {
  const out: Piece[] = []
  obj.updateWorldMatrix(true, true)
  const inv = space.matrixWorld.clone().invert()
  obj.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) {
      return
    }
    const mat = firstMaterial(mesh.material)
    const geo = mesh.geometry.clone()
    for (const k of Object.keys(geo.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') {
        geo.deleteAttribute(k)
      }
    }
    geo.applyMatrix4(inv.clone().multiply(mesh.matrixWorld))
    const count = geo.getAttribute('position').count
    const col = new Float32Array(count * 3)
    for (let k = 0; k < count; k++) {
      col.set([mat.color.r, mat.color.g, mat.color.b], k * 3)
    }
    geo.setAttribute('color', new BufferAttribute(col, 3))
    if (!geo.index) {
      geo.setIndex(Array.from({ length: count }, (_, i) => i))
    }
    const swatch = (mat.userData.swatch as Swatch | undefined) ?? 'plain'
    const piece: Piece = {
      geo,
      roughness: swatch === 'plain' ? mat.roughness : 1,
      rim: (mat.userData.rim as number | undefined) ?? 1,
      swatch,
    }
    if (weights) {
      piece.weights = weights
    }
    out.push(piece)
  })
  return out
}

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
    tris += p.geo.index?.count ?? 0
  }
  const outP = new Float32Array(verts * 3)
  const outN = new Float32Array(verts * 3)
  const outC = new Float32Array(verts * 3)
  const outS = new Float32Array(verts * 2)
  const outU = new Float32Array(verts * 2)
  const outL = new Float32Array(verts)
  const idx = new Uint32Array(tris)
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
      outS.set([p.roughness, p.rim], (vo + k) * 2)
    }
    const ia = g.index
    if (ia) {
      for (let k = 0; k < ia.count; k++) {
        idx[io + k] = ia.getX(k) + vo
      }
      io += ia.count
    }
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
  return out
}

/** Merge every piece into one skinned mesh under `parent`, bound in the current pose. */
export function bake(
  pieces: readonly Piece[],
  body: Body,
  parent: Object3D,
  material: Material,
): SkinnedMesh {
  const geo = mergePieces(pieces)
  const verts = geo.getAttribute('position').count
  const outI = new Uint16Array(verts * 4)
  const outW = new Float32Array(verts * 4)
  const index = new Map<Bone, number>(body.bones.map((b, i) => [b, i]))
  const p = new Vector3()
  let vo = 0
  for (const piece of pieces) {
    const pa = piece.geo.getAttribute('position')
    for (let k = 0; k < pa.count; k++) {
      const o = (vo + k) * 4
      if (piece.skin) {
        outI.set(piece.skin.index.subarray(k * 4, k * 4 + 4), o)
        outW.set(piece.skin.weight.subarray(k * 4, k * 4 + 4), o)
        continue
      }
      p.fromBufferAttribute(pa, k)
      const ws = [...(piece.weights ? piece.weights(p) : [])]
        .map(([b, w]) => [index.get(b) ?? 0, w] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
      const sum = ws.reduce((t, [, w]) => t + w, 0) || 1
      ws.forEach(([bi, w], c) => {
        outI[o + c] = bi
        outW[o + c] = w / sum
      })
    }
    vo += pa.count
  }
  // Compact the palette to the bones that actually carry weight.
  const used = new Map<number, number>()
  for (let k = 0; k < outI.length; k++) {
    if ((outW[k] ?? 0) > 0) {
      const bi = outI[k] ?? 0
      if (!used.has(bi)) {
        used.set(bi, used.size)
      }
    }
  }
  for (let k = 0; k < outI.length; k++) {
    outI[k] = (outW[k] ?? 0) > 0 ? (used.get(outI[k] ?? 0) ?? 0) : 0
  }
  const bones = [...used.keys()].map((bi) => body.bones[bi]).filter((b) => b !== undefined)
  geo.setAttribute('skinIndex', new BufferAttribute(outI, 4))
  geo.setAttribute('skinWeight', new BufferAttribute(outW, 4))
  const mesh = new SkinnedMesh(geo, material)
  mesh.name = 'Character'
  parent.add(mesh)
  parent.updateMatrixWorld(true)
  mesh.bind(new Skeleton(bones), mesh.matrixWorld)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  return mesh
}
