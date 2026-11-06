import { describe, expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'

const ROOT = 'public/experiments/out-west/3d/models'

/** Every clip the Frontier locomotion graph reaches for (player base + moves). */
const REQUIRED = [
  'Idle',
  'Idle_Gun',
  'Idle_Gun_Pointing',
  'Idle_Gun_Shoot',
  'Walk',
  'Run',
  'Sprint',
  'Crouch_Idle',
  'Crouch_Walk',
  'Jump_Loop',
  'Reload',
  'Aim_Up',
  'Aim_Down',
  'HitRecieve',
  'HitRecieve_2',
  'Death',
] as const

describe('CC0 animation clip set', () => {
  it('the built rig carries every clip the state graph uses', async () => {
    await MeshoptDecoder.ready
    const io = new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    const names = new Set<string>()
    for (const file of ['player.glb', 'moves.glb']) {
      // biome-ignore lint/performance/noAwaitInLoops: two small rig files, read in sequence
      const doc = await io.read(`${ROOT}/${file}`)
      for (const anim of doc.getRoot().listAnimations()) {
        names.add(anim.getName())
      }
    }
    for (const clip of REQUIRED) {
      expect(names.has(clip), `missing clip ${clip}`).toBe(true)
    }
  })
})
