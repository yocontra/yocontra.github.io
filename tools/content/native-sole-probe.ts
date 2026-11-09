/** Offline visual QA: referenced boot vertices transformed through the actual native skin. */
import {
  Mat4,
  type Mesh,
  type MeshInstance,
  TYPE_INT8,
  TYPE_INT16,
  TYPE_UINT8,
  TYPE_UINT16,
  Vec3,
} from 'playcanvas'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'

type Soles = Record<'L' | 'R', { y: number; vertices: number }>
const LEFT = new Set(['FootL', 'ToeL', 'ToeTipL'])
const RIGHT = new Set(['FootR', 'ToeR', 'ToeTipR'])
function stream(mesh: Mesh, semantic: string): number[] {
  const values: number[] = []
  mesh.getVertexStream(semantic, values)
  const element = mesh.vertexBuffer.format.elements.find((entry) => entry.name === semantic)
  const divisors: Record<number, number> = {
    [TYPE_UINT8]: 255,
    [TYPE_UINT16]: 65_535,
    [TYPE_INT16]: 32_767,
    [TYPE_INT8]: 127,
  }
  const divisor = element?.normalize ? divisors[element.dataType] : undefined
  return divisor ? values.map((value) => Math.max(-1, value / divisor)) : values
}
function sample(instance: MeshInstance, result: Soles): void {
  const skin = instance.skinInstance
  if (!skin?.skin) {
    return
  }
  const mesh = instance.mesh
  if (!mesh) {
    return
  }
  const positions = stream(mesh, 'POSITION')
  const joints = stream(mesh, 'BLENDINDICES')
  const weights = stream(mesh, 'BLENDWEIGHT')
  const indices: number[] = []
  mesh.getIndices(indices)
  const matrices = skin.bones.map((bone, i) =>
    new Mat4().mul2(bone.getWorldTransform(), skin.skin.inverseBindPose[i] ?? new Mat4()),
  )
  const bind = new Vec3()
  const point = new Vec3()
  const world = new Vec3()
  for (const vertex of new Set(indices)) {
    bind.set(
      positions[vertex * 3] ?? 0,
      positions[vertex * 3 + 1] ?? 0,
      positions[vertex * 3 + 2] ?? 0,
    )
    world.set(0, 0, 0)
    const influence = { L: 0, R: 0 }
    for (let c = 0; c < 4; c++) {
      const joint = joints[vertex * 4 + c] ?? 0
      const weight = weights[vertex * 4 + c] ?? 0
      matrices[joint]?.transformPoint(bind, point)
      world.x += point.x * weight
      world.y += point.y * weight
      world.z += point.z * weight
      const name = skin.skin.boneNames[joint] ?? ''
      if (LEFT.has(name)) {
        influence.L += weight
      }
      if (RIGHT.has(name)) {
        influence.R += weight
      }
    }
    for (const side of ['L', 'R'] as const) {
      if (influence[side] > 0.6) {
        result[side].y = Math.min(result[side].y, world.y)
        result[side].vertices++
      }
    }
  }
}
export function nativeSoleCoordinates(actor: DuelActor): Soles {
  const result = {
    L: { y: Number.POSITIVE_INFINITY, vertices: 0 },
    R: { y: Number.POSITIVE_INFINITY, vertices: 0 },
  }
  for (const render of actor.root.findComponents('render')) {
    for (const instance of render.meshInstances) {
      sample(instance, result)
    }
  }
  return result
}
