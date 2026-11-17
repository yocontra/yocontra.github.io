import { beforeAll, describe, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { Entity, Vec3 } from 'playcanvas'
import type { ShotRay } from '../../src/experiments/out-west/ffa/sim/combat.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { COLLISION } from '../../src/experiments/out-west/runtime/collision.ts'
import {
  Buttons,
  type CollisionData,
  neutralInput,
} from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
const source: CollisionData = {
  version: 'static-hit-fixture',
  boxes: [
    { id: 'ground', center: [0, -0.5, 0], halfExtents: [20, 0.5, 20] },
    { id: 'cover:16', center: [3, 1, 0], halfExtents: [0.5, 1, 0.5] },
    {
      id: 'rotated',
      center: [3, 1, -3],
      halfExtents: [0.5, 1, 0.5],
      rotation: [0, 45, 0],
    },
  ],
  meshes: [
    {
      id: 'building:wall',
      positions: [6, 0, -5, 6, 0, 5, 6, 3, 5, 6, 3, -5],
      indices: [0, 1, 2, 0, 2, 3],
    },
  ],
}
const ray: ShotRay = { ox: 0, oy: 1, oz: 0, dx: 1, dy: 0, dz: 0, maxT: 10 }

/** Independent pre-change query: the same native filter and distance used by released castWorld. */
function releasedDistance(simulation: ReturnType<typeof createSimulation>, shot: ShotRay) {
  const from = new Vec3(shot.ox, shot.oy, shot.oz)
  const to = new Vec3(
    shot.ox + shot.dx * shot.maxT,
    shot.oy + shot.dy * shot.maxT,
    shot.oz + shot.dz * shot.maxT,
  )
  const hit = simulation.app.systems.rigidbody?.raycastFirst(from, to, {
    filterCallback: (entity: Entity) => entity.name === 'collision',
  })
  return hit ? hit.point.distance(from) : null
}

describe('native static collider identity', () => {
  it('reports actual box, rotated box and mesh hits without changing released ray distances', () => {
    const simulation = createSimulation({ ammo, collision: source })
    const device = simulation.app.graphicsDevice
    const before = JSON.stringify(source)
    simulation.addPlayer('rider', [1, 0.9, 0])
    try {
      for (const shot of [
        ray,
        { ...ray, oz: 1.5 },
        { ...ray, oz: -3 },
        { ...ray, maxT: 2 },
        { ...ray, dy: 1, dx: 0 },
        { ...ray, oy: 3, dy: -1, dx: 0 },
      ]) {
        const released = releasedDistance(simulation, shot)
        expect(simulation.castWorld(shot)).toBe(released)
        expect(simulation.castWorldHit(shot)?.distance ?? null).toBe(released)
      }
      const box = simulation.castWorldHit(ray)
      expect(box?.collider).toEqual({ id: 'cover:16', kind: 'box', index: 1 })
      expect(box?.point).toEqual({ x: 2.5, y: 1, z: 0 })
      expect(box?.normal.x).toBeCloseTo(-1, 6)
      expect(box?.normal.y).toBeCloseTo(0, 6)
      const wall = simulation.castWorldHit({ ...ray, oz: 1.5 })
      expect(wall?.collider).toEqual({ id: 'building:wall', kind: 'mesh', index: 0 })
      expect(wall?.distance).toBeCloseTo(6, 6)
      const rotated = simulation.castWorldHit({ ...ray, oz: -2.9 })
      expect(rotated?.collider.id).toBe('rotated')
      expect(rotated?.distance).toBeCloseTo(3 - Math.SQRT1_2 + 0.1, 5)
      expect(rotated?.normal.x).toBeCloseTo(-Math.SQRT1_2, 4)
      expect(Math.abs(rotated?.normal.z ?? 0)).toBeCloseTo(Math.SQRT1_2, 4)
      expect(JSON.stringify(source)).toBe(before)
    } finally {
      simulation.dispose()
    }
    expect(device.textures.size).toBe(0)
    expect(device.buffers.size).toBe(0)
  })

  it('uses world ownership rather than names and keeps snapshots independent', () => {
    const simulation = createSimulation({ ammo, collision: source })
    try {
      const own = simulation.app.root.children.find((node) => node.getPosition().x === 3)
      expect(own).toBeDefined()
      if (!own) {
        throw new Error('Missing actual fixture collider')
      }
      own.name = 'renamed-authored-body'
      const foreign = new Entity('collision', simulation.app)
      foreign.setPosition(1, 1, 0)
      foreign.addComponent('collision', { type: 'box', halfExtents: new Vec3(0.1, 0.1, 0.1) })
      foreign.addComponent('rigidbody', { type: 'static' })
      simulation.app.root.addChild(foreign)
      expect(releasedDistance(simulation, ray)).toBeLessThan(1)
      const saved = simulation.castWorldHit(ray)
      expect(saved?.collider.id).toBe('cover:16')
      expect(simulation.castWorld(ray)).toBe(2.5)
      simulation.castWorldHit({ ...ray, oz: 1.5 })
      expect(saved?.point).toEqual({ x: 2.5, y: 1, z: 0 })
      expect(simulation.castWorldHit({ ...ray, maxT: 2 })).toBeNull()
    } finally {
      simulation.dispose()
    }
  })

  it('retains published cover IDs and supports legacy inputs without fabricated IDs', () => {
    const barrel = COLLISION.boxes.find((box) => box.id === 'cover:16')
    if (!barrel) {
      throw new Error('Missing published barrel collider')
    }
    const published = createSimulation({
      ammo,
      collision: { ...source, boxes: [barrel], meshes: [] },
    })
    const legacy = createSimulation({
      ammo,
      collision: { ...source, boxes: source.boxes.map(({ id: _id, ...box }) => box), meshes: [] },
    })
    try {
      const hit = published.castWorldHit({ ...ray, ox: 26, oy: 0.5, oz: 66.5 })
      expect(hit?.collider).toEqual({ id: 'cover:16', kind: 'box', index: 0 })
      expect(hit?.point.x).toBeCloseTo(28, 4)
      expect(legacy.castWorldHit(ray)?.collider).toEqual({ id: null, kind: 'box', index: 1 })
      expect(legacy.castWorld(ray)).toBe(2.5)
      published.dispose()
      expect(legacy.castWorld(ray)).toBe(2.5)
    } finally {
      published.dispose()
      legacy.dispose()
    }
  })

  it('identical native movement and support with and without authored identity', () => {
    const identified = createSimulation({ ammo, collision: source })
    const legacy = createSimulation({
      ammo,
      collision: {
        ...source,
        boxes: source.boxes.map(({ id: _id, ...box }) => box),
        meshes: source.meshes.map(({ id: _id, ...mesh }) => mesh),
      },
    })
    const first = identified.addPlayer('rider', [0, 0.9, 0])
    const second = legacy.addPlayer('rider', [0, 0.9, 0])
    const path: { x: number; grounded: boolean }[] = []
    try {
      for (let tick = 0; tick < 100; tick++) {
        const input = {
          ...neutralInput(),
          seq: tick,
          moveX: tick < 35 ? 1 : 0,
          buttons: tick === 50 ? Buttons.jump : 0,
        }
        const frame = new Map([['rider', input]])
        identified.step(frame)
        legacy.step(frame)
        expect(first).toEqual(second)
        path.push({ x: first.x, grounded: first.grounded })
      }
      expect(path[34]?.x).toBeLessThan(2.2)
      expect(path[34]?.grounded).toBe(true)
      expect(first.y).toBeCloseTo(0.9, 2)
      expect(first.grounded).toBe(true)
    } finally {
      identified.dispose()
      legacy.dispose()
    }
  })
})
