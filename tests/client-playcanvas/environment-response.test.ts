import { afterAll, beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { BODYGROUP_STATIC, type Entity } from 'playcanvas'
import { GameEffects } from '../../src/experiments/out-west/client/effects.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'
import type { SimEvent } from '../../src/experiments/out-west/ffa/sim/types.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { barrelFixture } from './barrel-response-fixture.ts'

const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
beforeAll(async () => {
  if (!priorDocument) {
    Object.defineProperty(globalThis, 'document', {
      value: Object.assign(new EventTarget(), { hidden: false }),
      configurable: true,
    })
  }
  await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
afterAll(() => {
  if (!priorDocument) {
    Reflect.deleteProperty(globalThis, 'document')
  }
})
const ray = { ox: 27, oy: 0.5, oz: 66.25, dx: 1, dy: 0, dz: 0, maxT: 1.45 }
function event(prop: number, tick = 101, seed = 1): Extract<SimEvent, { type: 'prop_break' }> {
  return {
    type: 'prop_break',
    prop,
    tick,
    seed,
    point: { x: 28, y: 0.5, z: 66.25 },
    impulse: { x: 2, y: 0.3, z: 0 },
  }
}

it('actual attach leaves only authored owners unbatched; snapshot removal survives LOD/batch regeneration without historical effects', async () => {
  const f = await barrelFixture()
  try {
    await f.props.ready
    expect(f.wall.render?.batchGroupId).toBeGreaterThanOrEqual(0)
    expect(
      f.owners.flatMap((entry) => [
        entry.near.render?.batchGroupId,
        entry.far.render?.batchGroupId,
      ]),
    ).toEqual(new Array(16).fill(-1))
    f.world.props[0] = 0
    f.props.update(f.world)
    expect(f.props.stats()).toEqual({ broken: 1, pieces: 0, bodies: 0, pending: 0 })
    expect(f.props.event(event(0, 99))).toBe(false)
    expect(f.props.event(event(0, 100))).toBe(false)
    expect(f.physics.castWorldHit(ray)).toBeNull()
    f.camera.setPosition(100, 1, 100)
    f.app.fire('update', 1 / 60)
    f.app.batcher?.generate([f.wall.render?.batchGroupId ?? -1])
    const hidden = f.owners[0]
    if (!hidden) {
      throw new Error('Missing actual barrel owner')
    }
    expect(hidden.owner.enabled).toBe(false)
    for (const mi of [
      ...(hidden.near.render?.meshInstances ?? []),
      ...(hidden.far.render?.meshInstances ?? []),
    ]) {
      expect(f.drawn()).not.toContain(mi)
    }
    f.camera.setPosition(28, 1, 66)
    f.app.fire('update', 1 / 60)
    expect(hidden.owner.enabled).toBe(false)
    expect(f.props.stats().pieces).toBe(0)
  } finally {
    expect(await f.destroy()).toEqual({
      renderBuffers: 0,
      renderTextures: 0,
      physicsBuffers: 0,
      physicsTextures: 0,
    })
  }
})

it('actual native borrowed-PBR timber/iron bodies are bounded, duplicate-safe, static-only and expire', async () => {
  const f = await barrelFixture()
  try {
    await f.props.ready
    f.props.update(f.world)
    for (let i = 0; i < 100; i++) {
      f.props.event(event(i % 2, 101 + i))
    }
    expect(f.props.stats()).toEqual({ broken: 2, pieces: 12, bodies: 12, pending: 0 })
    const bodies = f.physics.app.root.children.filter(
      (node) => node.name === 'barrel-debris',
    ) as Entity[]
    expect(bodies).toHaveLength(12)
    expect(bodies.every((body) => body.rigidbody?.mask === BODYGROUP_STATIC)).toBe(true)
    expect(bodies.some((body) => (body.rigidbody?.linearVelocity.x ?? 0) > 0)).toBe(true)
    const donor = f.owners[0]?.near.render?.meshInstances[0]?.material
    if (!donor) {
      throw new Error('Missing actual donor material')
    }
    const fragments = f.stage.children.filter((node) =>
      node.name.startsWith('barrel-debris:'),
    ) as Entity[]
    expect(fragments).toHaveLength(12)
    for (const piece of fragments) {
      for (const render of piece.findComponents('render')) {
        for (const mi of render.meshInstances) {
          expect(mi.material).toBe(donor)
        }
      }
    }
    for (let i = 0; i < 190; i++) {
      f.app.fire('update', 1 / 60)
    }
    expect(f.props.stats()).toEqual({ broken: 2, pieces: 0, bodies: 0, pending: 0 })
    for (let prop = 2; prop < 8; prop++) {
      f.props.event(event(prop))
    }
    expect(f.props.stats().bodies).toBe(24)
    f.props.destroy()
    f.props.event(event(0, 1000))
    expect(f.props.stats().bodies).toBe(0)
    expect(f.leases()).toEqual({ requests: 1, releases: 1 })
  } finally {
    expect(await f.destroy()).toEqual({
      renderBuffers: 0,
      renderTextures: 0,
      physicsBuffers: 0,
      physicsTextures: 0,
    })
  }
})

it('same-world stale health/events stay broken; fresh World or proven seed/tick reset restores roots, original collider and burst gates', async () => {
  const f = await barrelFixture()
  try {
    await f.props.ready
    f.props.update(f.world)
    expect(f.props.event(event(0))).toBe(true)
    f.world.tick = 102
    f.world.props[0] = 0
    f.props.update(f.world)
    f.world.tick = 99
    f.world.props[0] = 68
    f.props.update(f.world)
    expect(f.owners[0]?.owner.enabled).toBe(false)
    expect(f.physics.castWorld(ray)).toBeNull()
    expect(f.props.event(event(0))).toBe(false)
    const fresh = createWorld()
    fresh.tick = 5
    fresh.seed = 77
    f.props.update(fresh)
    expect(f.owners.every(({ owner }) => owner.enabled)).toBe(true)
    expect(f.props.stats()).toEqual({ broken: 0, pieces: 0, bodies: 0, pending: 0 })
    expect(f.physics.castWorldHit(ray)?.collider.id).toBe('cover:16')
    expect(f.props.event(event(0, 103))).toBe(false) // Previous session seed.
    expect(f.props.event(event(0, 6, 77))).toBe(true)
    fresh.props[0] = 0
    fresh.tick = 9
    f.props.update(fresh)
    fresh.props.fill(68)
    fresh.seed = 78
    fresh.tick = 1
    f.props.update(fresh)
    expect(f.owners.every(({ owner }) => owner.enabled)).toBe(true)
    expect(f.physics.castWorldHit(ray)?.collider.id).toBe('cover:16')
    expect(f.props.event(event(0, 2, 78))).toBe(true)
  } finally {
    expect(await f.destroy()).toEqual({
      renderBuffers: 0,
      renderTextures: 0,
      physicsBuffers: 0,
      physicsTextures: 0,
    })
  }
})

it('closing during an actual asynchronous parser lease releases the late asset without resurrection', async () => {
  const gate = Promise.withResolvers<void>()
  const f = await barrelFixture({ gate: gate.promise })
  try {
    f.props.update(f.world)
    f.props.event(event(0))
    expect(f.props.stats().pending).toBe(1)
    f.props.destroy()
    gate.resolve()
    await f.props.ready
    expect(f.props.stats()).toEqual({ broken: 1, pieces: 0, bodies: 0, pending: 0 })
    expect(f.stage.children.filter((node) => node.name.startsWith('barrel-debris:'))).toHaveLength(
      0,
    )
    expect(f.leases()).toEqual({ requests: 1, releases: 1 })
  } finally {
    gate.resolve()
    expect(await f.destroy()).toEqual({
      renderBuffers: 0,
      renderTextures: 0,
      physicsBuffers: 0,
      physicsTextures: 0,
    })
  }
})

it('asset failure rejects owned readiness and destroy leaves no native resources', async () => {
  const f = await barrelFixture({ reject: true })
  try {
    await expect(f.props.ready).rejects.toThrow('Injected fragment failure')
  } finally {
    expect(await f.destroy()).toEqual({
      renderBuffers: 0,
      renderTextures: 0,
      physicsBuffers: 0,
      physicsTextures: 0,
    })
  }
})

it('the real effect dispatcher emits one material sound only for a fresh accepted break, including after a proven new session', async () => {
  const f = await barrelFixture()
  const sounds: unknown[][] = []
  // Exercise the actual public dispatcher without constructing an audio context in a CPU fixture.
  const effects = Object.assign(Object.create(GameEffects.prototype), {
    hooks: { event: (value: SimEvent) => f.props.event(value) },
    audio: { impact: (...args: unknown[]) => sounds.push(args) },
  }) as GameEffects
  try {
    await f.props.ready
    f.world.props[0] = 0
    f.props.update(f.world)
    effects.event(event(0, 90))
    effects.event(event(0, 100))
    expect(sounds).toHaveLength(0)
    expect(f.props.stats().pieces).toBe(0)
    effects.event(event(1))
    effects.event(event(1))
    expect(sounds).toEqual([['wood', event(1).point, 0.9]])
    expect(f.props.stats().pieces).toBe(6)
    const fresh = createWorld()
    fresh.tick = 1
    fresh.seed = 77
    f.props.update(fresh)
    effects.event(event(1))
    expect(sounds).toHaveLength(1)
    effects.event(event(1, 2, 77))
    expect(sounds).toHaveLength(2)
    expect(f.props.stats().pieces).toBe(6)
  } finally {
    expect(await f.destroy()).toEqual({
      renderBuffers: 0,
      renderTextures: 0,
      physicsBuffers: 0,
      physicsTextures: 0,
    })
  }
})
