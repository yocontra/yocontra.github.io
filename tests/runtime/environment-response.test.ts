import { beforeAll, describe, expect, test as it } from 'bun:test'
import { Decoder, Encoder } from '@colyseus/schema'
import { file } from 'bun'
import { buildNav } from '../../api/src/town/nav.ts'
import { initializeAmmo } from '../../packages/durable-game-runtime/src/ammo.ts'
import { impactMaterial } from '../../src/experiments/out-west/client/audio-surfaces.ts'
import {
  applyFrontierState,
  propsFromSnapshot,
} from '../../src/experiments/out-west/client/state.ts'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import { COLLISION_VERSION } from '../../src/experiments/out-west/content/manifest.ts'
import {
  KICK_LIFETIME,
  tumbleweedOffset,
} from '../../src/experiments/out-west/contract/tumbleweed-motion.ts'
import { buildGrid, TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { COLLISION } from '../../src/experiments/out-west/runtime/collision.ts'
import { neutralInput, PROTOCOL_VERSION } from '../../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState } from '../../src/experiments/out-west/runtime/schema.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
const ray = { ox: 27, oy: 0.5, oz: 66.25, dx: 1, dy: 0, dz: 0, maxT: 1.45 }
function physics() {
  return createSimulation({
    ammo,
    collision: {
      version: 'snapshot-barrels',
      boxes: [
        { center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] },
        ...COLLISION.boxes.filter((box) => ['cover:16', 'cover:36'].includes(box.id ?? '')),
      ],
      meshes: [],
    },
  })
}
function game(props: unknown, seed = 1, tumbleweeds?: unknown) {
  return JSON.stringify({
    bags: [],
    strongbox: null,
    pickups: [],
    fuses: [],
    showdowns: [],
    mostWanted: 255,
    glass: [],
    props,
    seed,
    tumbleweeds,
  })
}
function state() {
  const source = new FrontierState()
  source.protocol = PROTOCOL_VERSION
  source.content = COLLISION_VERSION
  source.tick = 1
  source.game = game(ENVIRONMENT_PROPS.map(() => 68))
  return source
}
function client(initial: Uint8Array) {
  const schema = new FrontierState()
  const decoder = new Decoder(schema)
  decoder.decode(initial)
  propsFromSnapshot(schema.game)
  const world = createWorld()
  const predicted = physics()
  const debris = physics()
  world.propsChanged = (reset) => {
    for (const simulation of [predicted, debris]) {
      if (reset) {
        simulation.resetProps(world.props)
      } else {
        simulation.updateProps(world.props)
      }
    }
  }
  const sync = () => {
    applyFrontierState(schema, world, new Map(), new Map())
  }
  sync()
  return {
    world,
    predicted,
    debris,
    decoder,
    sync,
    destroy() {
      predicted.dispose()
      debris.dispose()
    },
  }
}

describe('persistent barrel state and native collision', () => {
  it('protocol4 rejects old room state before parsing incompatible environment JSON', () => {
    const world = createWorld()
    const source = state()
    source.protocol = 3
    source.game = '{}'
    const props = world.props
    const grid = world.grid
    expect(() => applyFrontierState(source, world, new Map(), new Map())).toThrow('Reload')
    expect(world.props).toBe(props)
    expect(world.grid).toBe(grid)
    source.protocol = PROTOCOL_VERSION
    source.game = game(Array(8).fill(68))
    expect(() => applyFrontierState(source, world, new Map(), new Map())).not.toThrow()
  })

  it('surface audio uses active room cover while retaining the actual wooden floor', () => {
    const layout = {
      ...TOWN,
      cover: TOWN.cover.map((cover, i) =>
        i === 16 ? { ...cover, kind: 'bucket' as const } : cover,
      ),
    }
    const intact = buildGrid(layout)
    const removed = buildGrid({ ...layout, cover: layout.cover.filter((_, i) => i !== 16) })
    const point = { x: 28.5, y: 0.9, z: 66.5 }
    expect(impactMaterial(point, intact, layout)).toBe('water')
    expect(impactMaterial(point, removed, layout)).toBe('wood')
  })

  it('two independent decoded clients and late join remove both native collision copies without replaying bursts', () => {
    const authority = state()
    const encoder = new Encoder(authority)
    const initial = encoder.encodeAll()
    const first = client(initial)
    const second = client(initial)
    const intact = createWorld()
    const oldNav = buildNav(intact.grid)
    encoder.discardChanges()
    try {
      expect(first.predicted.castWorldHit(ray)?.collider.id).toBe('cover:16')
      authority.tick++
      authority.game = game(ENVIRONMENT_PROPS.map((_, i) => (i === 0 || i === 2 ? 0 : 68)))
      const patch = encoder.encode()
      first.decoder.decode(patch)
      second.decoder.decode(patch)
      first.sync()
      second.sync()
      const late = client(encoder.encodeAll())
      try {
        for (const peer of [first, second, late]) {
          expect([...peer.world.props]).toEqual(
            ENVIRONMENT_PROPS.map((_, i) => (i === 0 || i === 2 ? 0 : 68)),
          )
          expect(peer.predicted.castWorld(ray)).toBeNull()
          expect(peer.debris.castWorld(ray)).toBeNull()
          expect(peer.world.events).toEqual([])
          const walker = peer.predicted.addPlayer('walk', [27, 0.9, 65.9])
          for (let i = 0; i < 20; i++) {
            peer.predicted.step(new Map([['walk', { ...neutralInput(), moveX: 1 }]]))
          }
          expect(walker.x).toBeGreaterThan(29.3)
          expect(impactMaterial({ x: 28.5, y: 0.5, z: 66.5 }, peer.world.grid)).toBe('wood')
          expect(impactMaterial({ x: 28.5, y: 0, z: 66.5 }, peer.world.grid)).toBe('wood')
          const nav = buildNav(peer.world.grid)
          expect(nav.free[66 * nav.n + 28]).toBe(0) // The other three real barrels still occupy this1m nav cell.
        }
        expect(oldNav.free[66 * oldNav.n + 28]).toBe(0)
        expect(intact.grid.layout?.cover).toHaveLength(intact.layout.cover.length)
        expect(first.world.layout.cover[16]).toBe(intact.layout.cover[16])
      } finally {
        late.destroy()
      }
    } finally {
      first.destroy()
      second.destroy()
    }
  })

  it('same-world stale snapshots cannot resurrect; a proven fresh seed/tick epoch restores original physics and navigation', () => {
    const source = state()
    const peer = client(new Encoder(source).encodeAll())
    try {
      source.tick = 100
      source.game = game([0, 0, 0, 0, 68, 68, 68, 68])
      applyFrontierState(source, peer.world, new Map(), new Map())
      expect(peer.predicted.castWorld(ray)).toBeNull()
      expect(peer.debris.castWorld(ray)).toBeNull()
      expect(buildNav(peer.world.grid).free[66 * buildNav(peer.world.grid).n + 28]).toBe(1)
      const brokenGrid = peer.world.grid
      source.tick = 99
      source.game = game(new Array(8).fill(68))
      applyFrontierState(source, peer.world, new Map(), new Map())
      expect(peer.world.tick).toBe(100)
      expect(peer.world.grid).toBe(brokenGrid)
      source.tick = 101
      expect(() => applyFrontierState(source, peer.world, new Map(), new Map())).toThrow(
        'Invalid town prop resurrection',
      )
      expect(peer.world.grid).toBe(brokenGrid)
      source.tick = 1
      source.game = game(new Array(8).fill(68), 77)
      applyFrontierState(source, peer.world, new Map(), new Map())
      expect(peer.world.seed).toBe(77)
      expect(peer.world.tick).toBe(1)
      expect([...peer.world.props]).toEqual(new Array(8).fill(68))
      for (const simulation of [peer.predicted, peer.debris]) {
        expect(simulation.castWorldHit(ray)?.collider.id).toBe('cover:16')
        expect(simulation.app.root.findComponents('rigidbody')).toHaveLength(3)
      }
      expect(buildNav(peer.world.grid).free[66 * buildNav(peer.world.grid).n + 28]).toBe(0)
      source.tick = 100
      source.game = game(new Array(8).fill(0), 1)
      expect(() => applyFrontierState(source, peer.world, new Map(), new Map())).toThrow(
        'Invalid town epoch',
      )
      expect(peer.world.seed).toBe(77)
    } finally {
      peer.destroy()
    }
  })

  it.each(
    [
      undefined,
      null,
      [],
      [0],
      [0, 68, 0],
      [0, -1],
      [0, 69],
      [0, 0.5],
      ['0', 68],
      { 0: 0, 1: 68 },
    ].map((value) => ({ value })),
  )(
    'rejects malformed bounded health without a partial world or native mutation: %j',
    ({ value: invalid }) => {
      const source = state()
      const peer = client(new Encoder(source).encodeAll())
      try {
        const oldGrid = peer.world.grid
        const oldProps = peer.world.props
        source.tick = 99
        source.game = game(invalid)
        expect(() => applyFrontierState(source, peer.world, new Map(), new Map())).toThrow(
          'Invalid town props',
        )
        expect(() => propsFromSnapshot(source.game)).toThrow('Invalid town props')
        expect(peer.world.tick).toBe(1)
        expect(peer.world.grid).toBe(oldGrid)
        expect(peer.world.props).toBe(oldProps)
        expect(peer.predicted.castWorldHit(ray)?.collider.id).toBe('cover:16')
      } finally {
        peer.destroy()
      }
    },
  )
})

it('broadcast native weeds share motion with a late join and clear on expiry or town reset', () => {
  const authority = state()
  const intact = ENVIRONMENT_PROPS.map(() => 68)
  const encoder = new Encoder(authority)
  const peer = client(encoder.encodeAll())
  encoder.discardChanges()
  try {
    expect(peer.world.tumbleweeds).toEqual([null, null, null])
    const kick = { tick: 8, x: 0.15, z: 0.1, vx: 1, vz: 0.5 }
    authority.tick = 12
    authority.game = game(intact, 1, [null, kick, null])
    peer.decoder.decode(encoder.encode())
    peer.sync()
    const late = client(encoder.encodeAll())
    try {
      expect(peer.world.tumbleweeds).toEqual([null, kick, null])
      expect(late.world.tumbleweeds).toEqual(peer.world.tumbleweeds)
      expect(tumbleweedOffset(late.world.tumbleweeds[1], late.world.tick)).toEqual(
        tumbleweedOffset(peer.world.tumbleweeds[1], peer.world.tick),
      )
      authority.tick = kick.tick + KICK_LIFETIME
      authority.game = game(intact)
      peer.decoder.decode(encoder.encode())
      peer.sync()
      expect(peer.world.tumbleweeds).toEqual([null, null, null])
      authority.tick = 2
      authority.game = game(intact, 19)
      late.decoder.decode(encoder.encode())
      late.sync()
      expect(late.world.seed).toBe(19)
      expect(late.world.tumbleweeds).toEqual([null, null, null])
    } finally {
      late.destroy()
    }
    authority.tick = 80
    authority.game = game(intact, 1, [{ ...kick, vx: 99 }, null, null])
    peer.decoder.decode(encoder.encode())
    expect(() => peer.sync()).toThrow('outside town bounds')
    expect(peer.world.tumbleweeds).toEqual([null, null, null])
  } finally {
    peer.destroy()
  }
})
