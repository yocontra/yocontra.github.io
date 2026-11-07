/** Source outfit primitives include palms/gloves too; replacing sleeves must retain those hands. */
import { Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey } from './fit.ts'
import { compactGarment } from './garment-mesh.ts'
import { SLOT } from './roles.ts'

const HAND = new Set(
  [
    'Wrist',
    'Fist',
    'Thumb1',
    'Thumb2',
    'Thumb3',
    'Index1',
    'Index2',
    'Index3',
    'Middle1',
    'Middle2',
    'Middle3',
    'Ring1',
    'Ring2',
    'Ring3',
    'Pinky1',
    'Pinky2',
    'Pinky3',
  ].flatMap((key) => [`${key}L`, `${key}R`]),
)
export function retainHands(piece: Piece, body: Body): Piece[] {
  if (piece.slot !== SLOT.Sleeves) {
    return []
  }
  const skin = piece.skin
  const index = piece.geo.getIndex()
  if (!(skin && index)) {
    return []
  }
  const keep: number[] = []
  const arms = (['L', 'R'] as const).flatMap((side) => {
    const wrist = body.bones
      .find((b) => boneKey(b.name) === `Wrist${side}`)
      ?.getWorldPosition(new Vector3())
    const elbow = body.bones
      .find((b) => boneKey(b.name) === `LowerArm${side}`)
      ?.getWorldPosition(new Vector3())
    return wrist && elbow ? [{ side, wrist, direction: wrist.clone().sub(elbow).normalize() }] : []
  })
  const position = piece.geo.getAttribute('position')
  const point = new Vector3()
  const distal = (vertex: number) => {
    point.fromBufferAttribute(position, vertex)
    const arm = arms.find((a) => a.side === (point.x >= 0 ? 'L' : 'R'))
    return !arm || point.sub(arm.wrist).dot(arm.direction) >= -0.02
  }
  const handWeight = (vertex: number) => {
    let weight = 0
    for (let influence = 0; influence < 4; influence++) {
      const bone = body.bones[skin.index[vertex * 4 + influence] ?? 0]
      if (bone && HAND.has(boneKey(bone.name))) {
        weight += skin.weight[vertex * 4 + influence] ?? 0
      }
    }
    return weight
  }
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const a = index.getX(triangle)
    const b = index.getX(triangle + 1)
    const c = index.getX(triangle + 2)
    if (
      Math.min(handWeight(a), handWeight(b), handWeight(c)) > 0.45 &&
      distal(a) &&
      distal(b) &&
      distal(c)
    ) {
      keep.push(a, b, c)
    }
  }
  if (keep.length === 0) {
    return []
  }
  const geo = compactGarment(piece.geo, keep)
  const vertices = geo.userData.sourceVertices as number[]
  const mapped = {
    index: new Uint16Array(vertices.length * 4),
    weight: new Float32Array(vertices.length * 4),
  }
  for (const [current, source] of vertices.entries()) {
    for (let influence = 0; influence < 4; influence++) {
      mapped.index[current * 4 + influence] = skin.index[source * 4 + influence] ?? 0
      mapped.weight[current * 4 + influence] = skin.weight[source * 4 + influence] ?? 0
    }
  }
  return [{ ...piece, geo, skin: mapped, slot: SLOT.Skin, name: 'Hands', lum: 0, roughness: 0.78 }]
}
