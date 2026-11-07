import { Bone, Box3, Vector3 } from 'three'
import type { FrontierGame } from '../../src/experiments/out-west/ffa/client/game.ts'
import type { CorpseRig } from '../../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import type { CorpsePhysics } from '../../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { boneKey } from '../../src/experiments/out-west/scene/fit.ts'

interface BoneFrame {
  key: string
  rendered: number[]
  target: number[]
  error: number
}
interface FrameMapping {
  id: number
  visible: boolean
  drivers: number
  maxOriginError: number
  frames: BoneFrame[]
}

/** Read the production corpse's currently presented bones and their actual physics targets. */
export function corpseFrames(game: FrontierGame) {
  const pool = Reflect.get(game, 'ragdolls') as {
    corpses: Map<number, { physics: CorpsePhysics | null }>
  } | null
  const result: FrameMapping[] = []
  const bounds = new Box3()
  for (const [id, record] of pool?.corpses ?? []) {
    const physics = record.physics
    if (!physics) {
      continue
    }
    const rig = Reflect.get(physics, 'rig') as CorpseRig
    // The cached presentation bound measures the actual skin, rigid gear and cloth margin.
    // An unweighted imported Root marker remains at the original capture and is not a body ROI.
    bounds.union(Reflect.get(physics, 'worldBounds') as Box3)
    const bones = new Map<string, Bone>()
    rig.root.traverse((node) => {
      if (node instanceof Bone) {
        bones.set(boneKey(node.name), node)
      }
    })
    const frames = physics.parts.flatMap((part) => {
      const bone = bones.get(part.link.key)
      if (!bone) {
        return []
      }
      const rendered = new Vector3().setFromMatrixPosition(bone.matrixWorld)
      return [
        {
          key: part.link.key,
          rendered: rendered.toArray(),
          target: part.pose.position.toArray(),
          error: rendered.distanceTo(part.pose.position),
        },
      ]
    })
    result.push({
      id,
      visible: rig.root.visible,
      drivers: frames.length,
      maxOriginError: Math.max(0, ...frames.map((frame) => frame.error)),
      frames,
    })
  }
  return { mapping: result, bounds }
}
