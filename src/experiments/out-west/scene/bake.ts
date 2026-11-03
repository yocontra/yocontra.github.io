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
import type { Body, WeightFn } from './fit.ts'

/**
 * One piece of the final character: root-space geometry (position, normal,
 * colour, index) authored in the current pose, its surface response, and how
 * it is skinned.
 */
export interface Piece {
  geo: BufferGeometry
  roughness: number
  rim: number
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
    geo.setIndex(g.index ? Array.from(g.index.array) : Array.from({ length: count }, (_, i) => i))
    if (!nrm) {
      geo.computeVertexNormals()
    }
    out.push({
      geo,
      roughness: mat.roughness,
      rim: (mat.userData.rim as number | undefined) ?? 1,
      skin: { index: outI, weight: outW },
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
      if (k !== 'position' && k !== 'normal') {
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
    const piece: Piece = {
      geo,
      roughness: mat.roughness,
      rim: (mat.userData.rim as number | undefined) ?? 1,
    }
    if (weights) {
      piece.weights = weights
    }
    out.push(piece)
  })
  return out
}

/** Plain merged geometry (position, normal, color, styMat, index). */
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
    for (let k = 0; k < pa.count; k++) {
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
  out.setAttribute('styMat', new BufferAttribute(outS, 2))
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
