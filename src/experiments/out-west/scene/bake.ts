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
import type { Swatch } from './atlas.ts'
import { type Body, boneKey, type WeightFn } from './fit.ts'
import type { Cuff } from './garment-mesh.ts'
import { mergePieces } from './piece-merge.ts'
import { SLOT, type Slot, slotOf } from './roles.ts'
import { atlasRoughness } from './style.ts'
import { westernKit } from './western-kit.ts'

/**
 * One piece of the final character: root-space geometry (position, normal,
 * colour, index) authored in the current pose, its surface response, and how
 * it is skinned.
 */
export interface Piece {
  /** An authored feature whose actual drawn bounds can frame a catalog detail. */
  feature?: 'badge' | undefined
  /** Root-space geometry: position, normal, colour (the tint), index, and `uv` when it has one. */
  geo: BufferGeometry
  /** The source material's name, for body parts (Hair, Skin, Shirt...). */
  name?: string
  /** The typed body slot, when the material is one of the character slots. */
  slot?: Slot | undefined
  paletteSlot?: number | undefined
  palette?: Uint8Array | undefined
  /** Roughness multiplier on the atlas (plain swatch: the roughness itself). */
  roughness: number
  /** Authored local surface variation, packed into the existing styMat.x channel. */
  roughnessAt?: Float32Array | undefined
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
  /**
   * A garment that hides the base cloth under it: is point `p` of base garment `garment`
   * (dominant `bone`) covered?
   */
  hide?: (p: Vector3, bone: string, garment: Slot | undefined) => boolean
  /** Not a surface the gunbelt and holster sit on (a coat sleeve; a poncho, worn over the belt). */
  unbelted?: boolean
  /** Cloth may conform to support after the dressed skeleton falls. */
  contactCloth?: boolean
}

/** A rigid piece riding one bone. */
export const onBone =
  (bone: Bone): WeightFn =>
  () => [[bone, 1]]

const firstMaterial = (m: Mesh['material']): MeshStandardMaterial =>
  (Array.isArray(m) ? m[0] : m) as MeshStandardMaterial

const tmpM = new Matrix4()

/** A plain (not interleaved, not normalised) attribute's array: read directly, no accessor. */
function plainArray(a: SkinnedMesh['geometry']['attributes'][string]): ArrayLike<number> | null {
  return a instanceof BufferAttribute && !a.normalized ? a.array : null
}

/**
 * Linear-blend skinning matrix of vertex `k` (bone world × inverse bind, weighted) into `out`.
 * Runs once per vertex of every body cast (tens of thousands), so plain attributes are read
 * straight from their arrays: `getComponent` here boxed every weight it returned.
 */
function blendBones(sm: SkinnedMesh, k: number, out: Matrix4): Matrix4 {
  const si = sm.geometry.getAttribute('skinIndex')
  const sw = sm.geometry.getAttribute('skinWeight')
  const ia = plainArray(si)
  const wa = plainArray(sw)
  const o = out.elements
  for (let q = 0; q < 16; q++) {
    o[q] = 0
  }
  for (let c = 0; c < 4; c++) {
    const w = wa ? (wa[k * sw.itemSize + c] ?? 0) : sw.getComponent(k, c)
    const li = ia ? (ia[k * si.itemSize + c] ?? 0) : si.getComponent(k, c)
    const bone = sm.skeleton.bones[li]
    const ib = sm.skeleton.boneInverses[li]
    if (w > 0 && bone && ib) {
      const t = tmpM.multiplyMatrices(bone.matrixWorld, ib).elements
      for (let q = 0; q < 16; q++) {
        o[q] = (o[q] as number) + (t[q] as number) * w
      }
    }
  }
  return out
}

/** The posed body meshes under `model` as pieces (posed positions and normals in `space`). */
export function bodyPieces(
  model: Object3D,
  space: Object3D,
  body: Body,
  shirtCut: 'straight' | 'fitted' = 'straight',
): Piece[] {
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
      slot: slotOf(mat),
      paletteSlot: mat.userData.paletteSlot as number | undefined,
      // textured body parts take their roughness from the atlas (skin and leather a touch glossier)
      roughness: uvA ? atlasRoughness(mat.name) : mat.roughness,
      rim: (mat.userData.rim as number | undefined) ?? 1,
      skin: { index: outI, weight: outW },
      swatch: uvA ? 'atlas' : 'plain',
      lum: recolor ? ((mat.userData.lum as number | undefined) ?? 0) : 0,
    })
  })
  return westernKit(out, body, shirtCut)
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

/** Merge every piece into one skinned mesh under `parent`, bound in the current pose. */
/** Base garments a fitted garment may hide where it covers them. */
const HIDEABLE: ReadonlySet<Slot> = new Set([
  SLOT.Shirt,
  SLOT.Sleeves,
  SLOT.Bracer,
  SLOT.Pauldron,
  SLOT.Belt,
  SLOT.Skin,
])

/** The bone carrying most of body vertex `k` (punctuation-free name). */
function dominant(skin: NonNullable<Piece['skin']>, body: Body, k: number): string {
  let best = 0
  let bone = ''
  for (let c = 0; c < 4; c++) {
    const w = skin.weight[k * 4 + c] ?? 0
    if (w > best) {
      best = w
      bone = boneKey(body.bones[skin.index[k * 4 + c] ?? 0]?.name ?? '')
    }
  }
  return bone
}

/**
 * Take off the base garments a fitted garment covers (`Piece.hide`): a triangle goes when all
 * three of its corners are under cloth. Nothing pokes through, and the coat's triangles are paid
 * for by the shirt and sleeves it hides.
 */
function hideUnder(pieces: readonly Piece[], body: Body): void {
  const hiders = pieces.filter((p) => p.hide)
  if (hiders.length === 0) {
    return
  }
  const v = new Vector3()
  for (const p of pieces) {
    const skin = p.skin
    if (!(skin && p.slot !== undefined && HIDEABLE.has(p.slot))) {
      continue
    }
    const pos = p.geo.getAttribute('position')
    const idx =
      p.geo.getIndex() ??
      new BufferAttribute(
        Uint32Array.from({ length: pos.count }, (_, i) => i),
        1,
      )
    const hidden = new Uint8Array(pos.count)
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k)
      const bone = dominant(skin, body, k)
      hidden[k] = hiders.some((h) => h.hide?.(v, bone, p.slot)) ? 1 : 0
    }
    const keep: number[] = []
    const prefix = new Uint32Array(idx.count + 1)
    for (let i = 0; i < idx.count; i += 3) {
      prefix[i] = keep.length
      const a = idx.getX(i)
      const b = idx.getX(i + 1)
      const c = idx.getX(i + 2)
      if (!(hidden[a] && hidden[b] && hidden[c])) {
        keep.push(a, b, c)
      }
      prefix[i + 3] = keep.length
    }
    if (keep.length < idx.count) {
      p.geo.setIndex(new BufferAttribute(new Uint32Array(keep), 1))
      const groups = [...p.geo.groups]
      p.geo.clearGroups()
      for (const group of groups) {
        const start = prefix[group.start] ?? 0
        const count = (prefix[group.start + group.count] ?? keep.length) - start
        p.geo.addGroup(start, count, group.materialIndex)
      }
    }
  }
}

/** Bind fitted cloth before occlusion too, so its covered vertices obey the same layering as the base. */
function fittedSkin(piece: Piece, body: Body): NonNullable<Piece['skin']> {
  if (piece.skin) {
    return piece.skin
  }
  const map = new Map(body.bones.map((bone, i) => [bone, i]))
  const pos = piece.geo.getAttribute('position')
  const skin = { index: new Uint16Array(pos.count * 4), weight: new Float32Array(pos.count * 4) }
  const p = new Vector3()
  for (let k = 0; k < pos.count; k++) {
    p.fromBufferAttribute(pos, k)
    const weights = [...(piece.weights?.(p) ?? [])]
      .map(([bone, w]) => [map.get(bone) ?? 0, w] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
    const sum = weights.reduce((total, [, w]) => total + w, 0) || 1
    weights.forEach(([bone, w], i) => {
      skin.index[k * 4 + i] = bone
      skin.weight[k * 4 + i] = w / sum
    })
  }
  return skin
}

export function bake(
  pieces: readonly Piece[],
  body: Body,
  parent: Object3D,
  material: Material,
): SkinnedMesh {
  const skinned = pieces.map((piece) => ({ ...piece, skin: fittedSkin(piece, body) }))
  hideUnder(skinned, body)
  const geo = mergePieces(skinned)
  const verts = geo.getAttribute('position').count
  const outI = new Uint16Array(verts * 4)
  const outW = new Float32Array(verts * 4)
  const palette = skinned.some((piece) => piece.paletteSlot !== undefined)
    ? new Float32Array(verts)
    : null
  let vo = 0
  const metadata = garmentMetadata(skinned)
  for (const piece of skinned) {
    const count = piece.geo.getAttribute('position').count
    palette?.fill(piece.paletteSlot ?? 0, vo, vo + count)
    if (piece.palette) {
      palette?.set(piece.palette, vo)
    }
    outI.set(piece.skin.index, vo * 4)
    outW.set(piece.skin.weight, vo * 4)
    vo += count
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
  Object.assign(geo.userData, metadata)
  const inverseMesh = parent.matrixWorld.clone().invert()
  geo.userData.restFrames =
    body.neutralFrames ??
    body.bones.map((bone) => ({
      key: boneKey(bone.name),
      matrix: inverseMesh.clone().multiply(bone.matrixWorld).toArray(),
    }))
  geo.setAttribute('skinIndex', new BufferAttribute(outI, 4))
  geo.setAttribute('skinWeight', new BufferAttribute(outW, 4))
  if (palette) {
    geo.setAttribute('paletteSlot', new BufferAttribute(palette, 1))
  }
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

export interface VertexRange {
  start: number
  count: number
}
export interface GarmentRanges {
  anatomyRanges: VertexRange[]
  clothRanges: VertexRange[]
  sleeveRanges: VertexRange[]
  bootRanges: VertexRange[]
  badgeRanges: VertexRange[]
  cuffs: Cuff[]
}

function garmentMetadata(pieces: readonly Piece[]): GarmentRanges {
  const anatomy: { start: number; count: number }[] = []
  const cloth: { start: number; count: number }[] = []
  const sleeves: { start: number; count: number }[] = []
  const cuffs: Cuff[] = []
  const badge: { start: number; count: number }[] = []
  const boots: VertexRange[] = []
  let vo = 0
  for (const piece of pieces) {
    const count = piece.geo.getAttribute('position').count
    if (piece.slot === SLOT.Boots) {
      boots.push({ start: vo, count })
    }
    if (piece.feature === 'badge') {
      badge.push({ start: vo, count })
    }
    if (
      [SLOT.Skin, SLOT.Shirt, SLOT.Sleeves, SLOT.Pants, SLOT.Boots].some(
        (slot) => slot === piece.slot,
      )
    ) {
      anatomy.push({ start: vo, count })
    }
    const vertexOffset = vo
    const pieceCuffs = piece.geo.userData.cuffs as Cuff[] | undefined
    for (const cuff of pieceCuffs ?? []) {
      cuffs.push({
        side: cuff.side,
        vertices: cuff.vertices.map((vertex) => vertex + vertexOffset),
      })
    }
    if (piece.slot === SLOT.Sleeves) {
      sleeves.push({ start: vo, count })
    }
    if (piece.contactCloth) {
      cloth.push({ start: vo, count })
    }
    vo += count
  }
  return {
    anatomyRanges: anatomy,
    clothRanges: cloth,
    sleeveRanges: sleeves,
    badgeRanges: badge,
    bootRanges: boots,
    cuffs,
  }
}
