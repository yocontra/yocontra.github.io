/** Surface treatment on the actual face and brow meshes; bones, UVs and authored identity stay intact. */

import { type BufferGeometry, Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey } from './fit.ts'
import { creaseNormals } from './normals.ts'
import type { Fit } from './outfit.ts'
import { SLOT } from './roles.ts'

const gaussian = (value: number, center: number, width: number) => {
  const distance = (value - center) / width
  return Math.exp(-(distance * distance))
}

export function finishFaces(pieces: readonly Piece[], body: Body, head: Fit['head']): void {
  const headIndex = body.bones.findIndex((bone) => boneKey(bone.name) === 'Head')
  for (const piece of pieces) {
    if (piece.slot === SLOT.Eye) {
      piece.roughness = 0.5
    } else if (piece.slot === SLOT.Brows) {
      shapeBrows(piece, head)
    } else if (piece.slot === SLOT.Skin && piece.skin && headIndex >= 0) {
      const neck = fitNeck(piece, body)
      skinSurface(piece, headIndex, head, neck)
    }
  }
}

function shapeBrows(piece: Piece, head: Fit['head']): void {
  const pos = piece.geo.getAttribute('position')
  for (const side of [-1, 1]) {
    const used: number[] = []
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (let i = 0; i < pos.count; i++) {
      if ((pos.getX(i) - head.cx) * side > 0) {
        used.push(i)
        lo = Math.min(lo, pos.getY(i))
        hi = Math.max(hi, pos.getY(i))
      }
    }
    const mid = (lo + hi) / 2
    for (const i of used) {
      pos.setY(i, mid + (pos.getY(i) - mid) * 0.7)
      pos.setZ(i, pos.getZ(i) - 0.001)
    }
  }
  pos.needsUpdate = true
  creaseNormals(piece.geo, 65)
}

/** The old cropped head includes a flared chest edge: fit that skin inside the actual collar. */
function fitNeck(piece: Piece, body: Body): Uint8Array {
  const pos = piece.geo.getAttribute('position')
  const moved = new Uint8Array(pos.count)
  const at = (name: string) =>
    body.bones.find((bone) => boneKey(bone.name) === name)?.getWorldPosition(new Vector3())
  const neck = at('Neck')
  const head = at('Head')
  const skin = piece.skin
  if (!(neck && head && skin)) {
    return moved
  }
  const keys = body.bones.map((bone) => boneKey(bone.name))
  const edge = neckBoundary(piece.geo)
  for (let i = 0; i < pos.count; i++) {
    const originalY = pos.getY(i)
    if (originalY < neck.y - 0.12 || originalY > head.y + 0.035) {
      continue
    }
    let neckWeight = 0
    for (let slot = 0; slot < 4; slot++) {
      if (keys[skin.index[i * 4 + slot] ?? 0] === 'Neck') {
        neckWeight += skin.weight[i * 4 + slot] ?? 0
      }
    }
    if (neckWeight < 0.3) {
      continue
    }
    // Extend the actual cropped neck boundary beneath the shirt, closing the throat opening.
    const y = edge[i] ? Math.min(originalY, neck.y - 0.04) : originalY
    const t = Math.max(
      0,
      Math.min(1, (y - neck.y - 0.035) / Math.max(0.01, head.y - neck.y - 0.035)),
    )
    const cx = neck.x + (head.x - neck.x) * t
    const cz = neck.z + (head.z - neck.z) * t
    const x = pos.getX(i) - cx
    const z = pos.getZ(i) - cz
    if (y > neck.y + 0.05 && z > 0.035) {
      continue
    }
    pos.setY(i, y)
    moved[i] = Number(y !== originalY)
    const radius = Math.hypot(x / 0.053, z / 0.044)
    const blend = Math.max(0, Math.min(1, (head.y + 0.035 - y) / 0.025))
    if (radius > 1) {
      const amount = 1 + (1 / radius - 1) * blend
      pos.setXYZ(i, cx + x * amount, y, cz + z * amount)
      moved[i] = 1
    }
    neckBinding(skin, i, keys)
  }
  pos.needsUpdate = true
  return moved
}

/** Weld UV duplicates for edge counting, without changing the original vertex/index layout. */
function neckBoundary(geometry: BufferGeometry): Uint8Array {
  const pos = geometry.getAttribute('position')
  const keys = Array.from(
    { length: pos.count },
    (_, i) =>
      `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`,
  )
  const edges = new Map<string, { count: number; a: number; b: number }>()
  const index = geometry.getIndex()
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const a = index.getX(i + corner)
        const b = index.getX(i + ((corner + 1) % 3))
        const left = keys[a] ?? ''
        const right = keys[b] ?? ''
        const pair = left < right ? `${left}|${right}` : `${right}|${left}`
        const edge = edges.get(pair)
        if (edge) {
          edge.count++
        } else {
          edges.set(pair, { count: 1, a, b })
        }
      }
    }
  }
  const boundary = new Set<string | undefined>()
  for (const edge of edges.values()) {
    if (edge.count === 1) {
      boundary.add(keys[edge.a])
      boundary.add(keys[edge.b])
    }
  }
  return Uint8Array.from(keys, (key) => Number(boundary.has(key)))
}

/** Neck skin follows neck/head, rather than inheriting the removed fantasy shoulder flange. */
function neckBinding(
  skin: NonNullable<Piece['skin']>,
  vertex: number,
  keys: readonly string[],
): void {
  let total = 0
  for (let slot = 0; slot < 4; slot++) {
    const index = vertex * 4 + slot
    const key = keys[skin.index[index] ?? 0]
    if (key !== 'Head' && key !== 'Neck') {
      skin.weight[index] = 0
    }
    total += skin.weight[index] ?? 0
  }
  if (total > 0) {
    for (let slot = 0; slot < 4; slot++) {
      const index = vertex * 4 + slot
      skin.weight[index] = (skin.weight[index] ?? 0) / total
    }
  }
}

function skinSurface(piece: Piece, headIndex: number, head: Fit['head'], neck: Uint8Array): void {
  const skin = piece.skin
  if (!skin) {
    return
  }
  const pos = piece.geo.getAttribute('position')
  const roughness = new Float32Array(pos.count).fill(piece.roughness)
  const face = neck
  for (let i = 0; i < pos.count; i++) {
    let weight = 0
    for (let slot = 0; slot < 4; slot++) {
      if (skin.index[i * 4 + slot] === headIndex) {
        weight += skin.weight[i * 4 + slot] ?? 0
      }
    }
    if (weight < 0.5) {
      continue
    }
    face[i] = 1
    const x = Math.abs(pos.getX(i) - head.cx)
    const y = pos.getY(i)
    const front = Math.max(0, Math.min(1, (pos.getZ(i) - head.cz + 0.01) / 0.07))
    const nose = gaussian(x, 0, 0.021) * gaussian(y, head.eye - 0.032, 0.052)
    const cheek = gaussian(x, 0.05, 0.025) * gaussian(y, head.eye - 0.036, 0.025)
    const lip = gaussian(x, 0, 0.03) * gaussian(y, head.chin + (head.eye - head.chin) * 0.48, 0.013)
    roughness[i] = 0.78 - front * (nose * 0.18 + cheek * 0.085 + lip * 0.1)
  }
  const index = piece.geo.getIndex()
  const triangles: number[] = []
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i)
      const b = index.getX(i + 1)
      const c = index.getX(i + 2)
      if (face[a] && face[b] && face[c]) {
        triangles.push(a, b, c)
      }
    }
  }
  if (triangles.length > 0) {
    creaseNormals(piece.geo, 75, Uint32Array.from(triangles))
  }
  piece.roughnessAt = roughness
}
