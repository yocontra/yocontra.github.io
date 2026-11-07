import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import { Plane, type World } from 'cannon-es'
import { Group, SkinnedMesh, Texture, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { dressedRider } from '../src/experiments/out-west/ffa/scene/crowd/actor.ts'
import { cloneCorpse } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { corpseGround } from '../src/experiments/out-west/ffa/scene/ragdoll-cloth-contact.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { buildGrid } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'

let assets: Assets
let props: Awaited<ReturnType<GLTFLoader['parseAsync']>>
beforeAll(async () => {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const load = async (name: string) => {
    const model = await loader.parseAsync(
      await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(),
      '',
    )
    markCharacterSlots(model)
    return model
  }
  const [player, punk] = await Promise.all(['player', 'punk'].map(load))
  if (!(player && punk)) {
    throw new Error('Missing actual Punk assets')
  }
  props = await loader.parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  const texture = new Texture()
  assets = {
    player,
    props,
    tex: {
      ground: texture,
      groundN: texture,
      planks: texture,
      planksN: texture,
      vplanks: texture,
      vplanksN: texture,
      char: { map: texture, normal: texture, arm: texture },
    },
    body: async () => punk,
    bodyNow: () => punk,
    lookReady: async () => undefined,
    lookLoaded: () => true,
  }
})
afterAll(() => assets.tex.ground.dispose())

function rigidSoles(root: Group) {
  const entries: { mesh: SkinnedMesh; indices: number[] }[] = []
  root.traverse((mesh) => {
    if (!(mesh instanceof SkinnedMesh)) {
      return
    }
    const skin = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    const indices: number[] = []
    for (const vertex of new Set<number>(mesh.geometry.index?.array ?? [])) {
      for (const side of ['L', 'R']) {
        let total = 0
        for (let slot = 0; slot < 4; slot++) {
          const bone = mesh.skeleton.bones[skin.getComponent(vertex, slot)]
          if (bone && [`Foot${side}`, `Toe${side}`].includes(boneKey(bone.name))) {
            total += weights.getComponent(vertex, slot)
          }
        }
        if (total >= 1 - 1e-6) {
          indices.push(vertex)
        }
      }
    }
    entries.push({ mesh, indices })
  })
  return entries
}

function supportHeights(world: World): number[] {
  return world.contacts.flatMap((contact) => {
    const plane = contact.bi.mass === 0 ? contact.bi : contact.bj
    const normalY = plane === contact.bi ? contact.ni.y : -contact.ni.y
    return plane.shapes.some((shape) => shape instanceof Plane) &&
      normalY > 0.999 &&
      contact.multiplier > 0.01
      ? [plane.position.y]
      : []
  })
}

function restingSoles(oldSupports: boolean) {
  const grid = buildGrid()
  const pool = new Ragdolls({
    root: new Group(),
    grid,
    props,
    source: {
      captureCorpse: async () => null,
      suppressCorpse: () => false,
      releaseCorpse: () => undefined,
    },
  })
  const look = lookFor(['outfit.trail-duds'], 1)
  look.look.base = 'punk'
  // This prepares the immutable fit at scale one before the normal living scale is applied.
  const actor = dressedRider(assets, look)
  new Group().add(actor.root)
  actor.root.scale.setScalar(1.25)
  actor.play('Idle_Gun_Pointing', 0)
  actor.update(0.37)
  actor.root.position.set(72, 0, 69)
  actor.root.updateMatrixWorld(true)
  const full = actor.meshes[0]?.geometry
  if (!full) {
    throw new Error('Missing actual Punk skin')
  }
  ownGeometry(full)
  const rig = cloneCorpse(actor, full, 'punk-resting-sole')
  if (oldSupports) {
    for (const link of rig.links) {
      if (link.anatomySpheres) {
        link.anatomySpheres = link.anatomySpheres.slice(0, 12)
      }
    }
  }
  const physics = new CorpsePhysics(
    pool.world,
    rig,
    {
      velocity: new Vector3(),
      impulse: new Vector3(3, 0.1, 0),
    },
    corpseGround(grid),
  )
  const soles = rigidSoles(rig.root)
  const heights: number[] = []
  const point = new Vector3()
  const groundPlanes: number[] = []
  try {
    for (let tick = 0; tick < 360; tick++) {
      physics.limitSpeed()
      pool.world.step(1 / 120)
      physics.sync(false)
      if (tick < 300) {
        continue
      }
      let min = Number.POSITIVE_INFINITY
      for (const { mesh, indices } of soles) {
        for (const vertex of indices) {
          mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld)
          min = Math.min(min, point.y)
        }
      }
      heights.push(min)
      groundPlanes.push(...supportHeights(pool.world))
    }
    return { heights, groundPlanes }
  } finally {
    physics.dispose()
    pool.dispose()
    releaseGeometry(full)
    actor.dispose()
  }
}

it('removes the reproduced resting Punk sole penetration on the actual town ground', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.5)
  try {
    const old = restingSoles(true)
    const current = restingSoles(false)
    expect(old.heights).toHaveLength(60)
    expect(current.heights).toHaveLength(60)
    expect([...new Set(old.groundPlanes)]).toEqual([0])
    expect([...new Set(current.groundPlanes)]).toEqual([0])
    // The old twelve remain the negative control; these are raw visible world heights.
    expect(Math.max(...old.heights)).toBeLessThan(-0.02)
    expect(Math.min(...current.heights)).toBeGreaterThan(-0.01)
    expect(Math.max(...current.heights)).toBeLessThan(0.01)
  } finally {
    random.mockRestore()
  }
})
