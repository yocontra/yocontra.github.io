/** Explicit64-rig lifetime stress:32living riders plus32cloned corpses, beyond production's32total. */
import { Body, Plane, Vec3, World } from 'cannon-es'
import {
  BufferAttribute,
  InterleavedBufferAttribute,
  Mesh,
  type PerspectiveCamera,
  type Scene,
  Vector3,
  type WebGLRenderer,
} from 'three'
import { corpsePreparationStats } from '../../src/experiments/out-west/ffa/scene/crowd/corpse-capture.ts'
import type { CorpseRig } from '../../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { vatCacheStats } from '../../src/experiments/out-west/ffa/scene/crowd/vat.ts'
import type { Crowd, CrowdPlayer } from '../../src/experiments/out-west/ffa/scene/crowd.ts'
import { lookFor } from '../../src/experiments/out-west/ffa/scene/looks.ts'
import { CorpsePhysics } from '../../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { CorpseBroadphase } from '../../src/experiments/out-west/ffa/scene/ragdoll-broadphase.ts'
import { SparseCorpseContacts } from '../../src/experiments/out-west/ffa/scene/ragdoll-collisions.ts'
import { gpuPrograms } from './gpu.ts'

export interface CorpseMemory {
  stage: string
  living: number
  corpses: number
  textures: number
  textureBytes: number
  geometryBytes: number
  geometries: number
  draws: number
  preparation: ReturnType<typeof corpsePreparationStats>
  vat: ReturnType<typeof vatCacheStats>
}
const bytes = () => (Reflect.get(globalThis, '__owTextureBytes') as () => number)()
function geometryBytes(scene: Scene): number {
  const buffers = new Set<ArrayBufferLike>()
  scene.traverse((node) => {
    if (!(node instanceof Mesh)) {
      return
    }
    for (const attribute of Object.values(node.geometry.attributes)) {
      if (attribute instanceof BufferAttribute) {
        buffers.add(attribute.array.buffer)
      } else if (attribute instanceof InterleavedBufferAttribute) {
        buffers.add(attribute.data.array.buffer)
      }
    }
    if (node.geometry.index) {
      buffers.add(node.geometry.index.array.buffer)
    }
  })
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0)
}
function sample(
  label: string,
  corpses: number,
  stage: { scene: Scene; gl: WebGLRenderer; camera: PerspectiveCamera },
): CorpseMemory {
  const { scene, gl, camera } = stage
  gl.info.reset()
  gl.render(scene, camera)
  return {
    stage: label,
    living: 32,
    corpses,
    textures: gl.info.memory.textures,
    textureBytes: bytes(),
    geometryBytes: geometryBytes(scene),
    geometries: gl.info.memory.geometries,
    draws: gl.info.render.calls,
    preparation: corpsePreparationStats(),
    vat: vatCacheStats(),
  }
}
function moveRig(rig: CorpseRig, z: number): void {
  rig.root.position.z += z
  rig.root.updateMatrixWorld(true)
  for (const link of rig.links) {
    for (const position of [link.position, link.start, link.end, link.restPosition, link.restEnd]) {
      if (position) {
        position.z += z
      }
    }
  }
}

export async function stressCorpseResidency(stage: {
  scene: Scene
  crowd: Crowd
  players: CrowdPlayer[]
  gl: WebGLRenderer
  camera: PerspectiveCamera
}): Promise<{
  memory: CorpseMemory[]
  capture: { nearMs: number[]; readyMs: number[] }
  stepMs: number[]
  gpu: ReturnType<typeof gpuPrograms>
}> {
  const { scene, crowd, players } = stage
  const memory = [sample('baseline32living', 0, stage)]
  const capture = { nearMs: [] as number[], readyMs: [] as number[] }
  const stepMs: number[] = []
  let gpu = gpuPrograms(stage.gl)
  const world = new World({ gravity: new Vec3(0, -9.81, 0), allowSleep: true })
  world.broadphase = new CorpseBroadphase(world)
  world.collisionMatrix = new SparseCorpseContacts()
  world.collisionMatrixPrevious = new SparseCorpseContacts()
  const floor = new Body({ mass: 0, shape: new Plane() })
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  world.addBody(floor)
  const physical: CorpsePhysics[] = []
  try {
    for (const [index, player] of players.entries()) {
      const start = performance.now()
      const pending = crowd.captureCorpse(player.id)
      capture.nearMs.push(performance.now() - start)
      const rig = await pending
      capture.readyMs.push(performance.now() - start)
      if (!rig) {
        throw new Error(`Missing actual corpse${player.id}`)
      }
      moveRig(rig, 10)
      scene.add(rig.root)
      physical.push(
        new CorpsePhysics(world, rig, { velocity: new Vector3(), impulse: new Vector3(0, 0, -3) }),
      )
      if (index === 7) {
        memory.push(sample('32 living + 8 corpses', 8, stage))
      }
    }
    for (let tick = 0; tick < 180; tick++) {
      const start = performance.now()
      for (const corpse of physical) {
        corpse.limitSpeed()
      }
      world.step(1 / 120)
      for (const corpse of physical) {
        corpse.sync(false)
      }
      stepMs.push(performance.now() - start)
    }
    memory.push(sample('32 living + 32 corpses', 32, stage))
    gpu = gpuPrograms(stage.gl)
    if (!gpu.programs.some((program) => program.names.includes('corpseOffset'))) {
      throw new Error('Actual corpse cloth shader was not rendered')
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const player of players) {
        crowd.setLook(
          player.id,
          lookFor(
            [
              cycle % 2 ? 'outfit.gamblers-frock' : 'outfit.striped-poncho',
              player.id % 2 ? 'gun.hardins-pair' : 'gun.engraved-ivory',
              'hat.bronze-band',
            ],
            player.id,
          ),
        )
      }
      await crowd.prepareLooks()
      await crowd.precast(2, -1, (id) => id)
      crowd.update(players, 0, 0, 1 / 60, 20 + cycle)
      memory.push(sample(`reskin${cycle + 1}-oldcorpsesleased`, 32, stage))
    }
  } finally {
    for (const corpse of physical) {
      corpse.dispose()
    }
  }
  memory.push(sample('corpsesreleased32living', 0, stage))
  if (gpu.programs.some((program) => !program.linked || program.slots > gpu.maxVertexAttribs)) {
    throw new Error('Corpse shader linkage or attribute limit failed')
  }
  return { memory, capture, stepMs, gpu }
}
