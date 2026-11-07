import { describe, expect, it } from 'bun:test'
import { type JoinProfile, LobbyCore, type Peer } from '../api/src/town/core.ts'
import { broadcastSnapshots } from '../api/src/town/core-snapshots.ts'
import {
  CONTRACT_VERSION,
  EV_GLASS_BREAK,
  NONE,
  type ServerControl,
  type TownPersistentState,
} from '../src/experiments/out-west/contract/town.ts'
import { NetClient } from '../src/experiments/out-west/ffa/client/net.ts'
import { Writer } from '../src/experiments/out-west/ffa/sim/bytes.ts'
import { decodeSnapshot } from '../src/experiments/out-west/ffa/sim/codec.ts'
import type { WireEvent } from '../src/experiments/out-west/ffa/sim/codec-events.ts'
import { dropBag } from '../src/experiments/out-west/ffa/sim/death.ts'
import { persistentStateFor } from '../src/experiments/out-west/ffa/sim/snapshot.ts'
import type { Showdown, SimEvent } from '../src/experiments/out-west/ffa/sim/types.ts'

class StatePeer implements Peer {
  readonly packets: (Uint8Array | string)[] = []
  closed = false
  send(packet: Uint8Array | string): void {
    this.packets.push(packet)
  }
  close(): void {
    this.closed = true
  }
}

const profile = (accountId: string): JoinProfile => ({
  accountId,
  name: accountId,
  level: 10,
  prestige: 0,
  loadout: [],
  banked: 0,
  tcpRtt: null,
})

function fixture() {
  const core = new LobbyCore('persistent-test', 7)
  core.ambientPopulation = 0
  const peer = new StatePeer()
  core.join(profile('host'), peer, 0)
  core.join(profile('other'), new StatePeer(), 0)
  for (const player of core.world.players) {
    if (player) {
      player.x = 120 + player.id
      player.z = 120
    }
  }
  const events: WireEvent[] = []
  const errors: string[] = []
  let replacements = 0
  let closed = 0
  const client = new NetClient({
    onWelcome: () => undefined,
    onControl: () => undefined,
    onEvent: (event) => events.push(event),
    onPredictedShot: () => undefined,
    onPersistentState: () => replacements++,
    onIncompatible: (message) => errors.push(message),
  })
  client.attach({ kind: 'remote', send: () => undefined, close: () => closed++ })
  const deliver = (from: StatePeer = peer) => {
    const packets = from.packets.splice(0)
    for (const packet of packets) {
      client.handle(typeof packet === 'string' ? packet : packet.slice().buffer, 50)
    }
    return packets
  }
  const broadcast = () =>
    broadcastSnapshots({
      world: core.world,
      sessions: core.sessions.values(),
      writer: new Writer(),
      metrics: core.metrics,
    })
  return {
    core,
    peer,
    client,
    events,
    errors,
    deliver,
    broadcast,
    replacements: () => replacements,
    closed: () => closed,
  }
}

describe('Frontier persistent state through real core and netcode', () => {
  it('retains complete preload state beyond the event cap without replaying past effects', () => {
    const f = fixture()
    const world = f.core.world
    world.glass.fill(1)
    for (let i = 0; i < 300; i++) {
      dropBag(world, { x: 20, z: 64 }, 100 + i, NONE)
    }
    const pickup = world.pickups[0]
    if (!pickup) {
      throw new Error('missing pickup fixture')
    }
    pickup.availableAt = 100
    world.fuses.push({ by: 0, x: 22, z: 64, explodeAt: 20 })
    world.showdowns.set(1, {
      id: 1,
      a: 0,
      b: 1,
      cx: 120.5,
      cz: 120,
      startTick: 0,
      callTick: 100,
      fakeTicks: [],
      phase: 'wait',
    })
    f.deliver()
    expect(f.client.persistent.ready).toBe(false)
    f.core.tick(50)
    const packets = f.deliver()
    expect(packets.at(-1)).toBeTypeOf('string')
    const control = JSON.parse(String(packets.at(-1))) as ServerControl
    expect(control.type).toBe('town_state')
    expect(f.client.persistent.ready).toBe(true)
    expect(f.client.persistent.brokenWindows.size).toBe(296)
    expect(f.client.persistent.bags.size).toBe(300)
    expect(f.client.persistent.unavailablePickups.has(0)).toBe(true)
    expect(f.client.persistent.fuses.size).toBe(1)
    expect(f.client.persistent.showdowns.get(1)?.calledTick).toBeNull()
    expect(f.events.filter((event) => event.type === EV_GLASS_BREAK)).toHaveLength(0)
    expect(f.errors).toHaveLength(0)
    expect(f.replacements()).toBe(1)
  })

  it('silently replaces and removes stale state across repeated real reconnects', () => {
    const f = fixture()
    f.core.world.glass[0] = 1
    dropBag(f.core.world, { x: 20, z: 64 }, 100, NONE)
    f.core.world.fuses.push({ by: 0, x: 22, z: 64, explodeAt: 20 })
    f.core.tick(50)
    f.deliver()
    expect(f.client.persistent.bags.size).toBe(1)
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      f.core.world.bags = []
      f.core.world.fuses = []
      f.core.world.glass.fill(0)
      f.core.world.showdowns.clear()
      for (const pickup of f.core.world.pickups) {
        pickup.availableAt = 0
      }
      f.client.reset()
      expect(f.client.persistent.ready).toBe(false)
      const next = new StatePeer()
      f.core.join(profile('host'), next, 100)
      f.core.tick(100 + reconnect * 50)
      f.deliver(next)
      expect(f.client.persistent.ready).toBe(true)
      expect(f.client.persistent.bags.size).toBe(0)
      expect(f.client.persistent.brokenWindows.size).toBe(0)
      expect(f.client.persistent.fuses.size).toBe(0)
      expect(f.client.persistent.showdowns.size).toBe(0)
      expect(f.client.persistent.unavailablePickups.size).toBe(0)
    }
    expect(f.errors).toHaveLength(0)
    expect(f.replacements()).toBe(3)
    expect(f.events).toHaveLength(0)
    expect(f.peer.closed).toBe(true)
  })

  it('presents a new live pane once even if duplicated in a full tick or later delta', () => {
    const f = fixture()
    f.core.tick(50)
    f.deliver()
    const session = f.core.sessions.get(0)
    if (!session) {
      throw new Error('missing session')
    }
    session.stream.reset()
    f.core.world.glass[3] = 1
    f.core.world.events = [
      { type: 'glass_break', window: 3 },
      { type: 'glass_break', window: 3 },
    ]
    f.broadcast()
    f.deliver()
    expect(f.events.filter((event) => event.type === EV_GLASS_BREAK)).toHaveLength(1)
    expect(f.client.persistent.brokenWindows.has(3)).toBe(true)
    f.broadcast()
    f.deliver()
    expect(f.events.filter((event) => event.type === EV_GLASS_BREAK)).toHaveLength(1)
  })

  it('recovers authoritative state outside the capped live list on overflow', () => {
    const f = fixture()
    f.core.tick(50)
    f.deliver()
    f.core.world.glass.fill(1)
    f.core.world.events = Array.from(f.core.world.glass.keys(), (window) => ({
      type: 'glass_break',
      window,
    }))
    f.broadcast()
    const packets = f.deliver()
    const binary = packets.find((packet) => packet instanceof Uint8Array)
    if (!(binary instanceof Uint8Array)) {
      throw new Error('missing live binary snapshot')
    }
    expect(decodeSnapshot(binary, new Map())?.events).toHaveLength(255)
    expect(f.client.persistent.brokenWindows.size).toBe(296)
    expect(f.client.persistent.brokenWindows.has(295)).toBe(true)
    expect(f.replacements()).toBe(2)
    expect(f.events).toHaveLength(255)
    expect(f.errors).toHaveLength(0)
  })
})

describe('Frontier live state and external validation', () => {
  it('keeps bag, pickup, callout, showdown and fuse transitions once-only during live play', () => {
    const f = fixture()
    f.core.tick(50)
    f.deliver()
    const world = f.core.world
    dropBag(world, { x: 20, z: 64 }, 100, NONE)
    const bag = world.events.at(-1)
    if (bag?.type !== 'bag_drop') {
      throw new Error('missing live bag')
    }
    const showdown: Showdown = {
      id: 42,
      a: 0,
      b: 1,
      cx: 120.5,
      cz: 120,
      startTick: 1,
      callTick: 100,
      fakeTicks: [],
      phase: 'wait',
    }
    const changes: SimEvent[] = [
      bag,
      { type: 'pickup_taken', spot: 0, player: 0 },
      { type: 'callout', challenger: 0, target: 1 },
      { type: 'showdown_start', showdown },
      { type: 'dynamite_thrown', player: 0, x: 22, z: 64, fuseTicks: 40 },
    ]
    world.events = changes.flatMap((event) => [event, event])
    world.tick++
    f.broadcast()
    f.deliver()
    expect(f.events).toHaveLength(5)
    expect(f.client.persistent.bags.size).toBe(1)
    expect(f.client.persistent.unavailablePickups.has(0)).toBe(true)
    expect(f.client.persistent.callouts.size).toBe(0)
    expect(f.client.persistent.showdowns.get(42)?.calledTick).toBeNull()
    expect([...f.client.persistent.fuses.values()][0]?.explodeAt).toBe(41)
    const removals: SimEvent[] = [
      { type: 'bag_gone', bagId: bag.bag.id, by: 0 },
      { type: 'pickup_ready', spot: 0 },
      { type: 'showdown_end', id: 42, winner: 0, outcome: 0, winnerMs: 200 },
      { type: 'explosion', by: 0, x: 22, z: 64 },
    ]
    world.events = removals.flatMap((event) => [event, event])
    world.tick++
    f.broadcast()
    f.deliver()
    expect(f.events).toHaveLength(9)
    expect(f.client.persistent.bags.size).toBe(0)
    expect(f.client.persistent.unavailablePickups.size).toBe(0)
    expect(f.client.persistent.showdowns.size).toBe(0)
    expect(f.client.persistent.fuses.size).toBe(0)
  })

  it.each([
    (state: TownPersistentState) => ({ ...state, brokenWindows: [296] }),
    (state: TownPersistentState) => ({ ...state, brokenWindows: [0, 0] }),
    (state: TownPersistentState) => ({ ...state, unavailablePickups: [999] }),
    (state: TownPersistentState) => ({
      ...state,
      fuses: [{ player: 0, x: 20, z: 64, explodeAt: state.tick + 41 }],
    }),
    (state: TownPersistentState) => ({
      ...state,
      showdowns: [{ id: 1, a: 0, b: 1, cx: 20, cz: 64, calledTick: state.tick + 1 }],
    }),
    (state: TownPersistentState) => ({ ...state, bags: new Array(65_536).fill(null) }),
    () => ({ tick: 0 }),
  ])(
    'rejects invalid complete-state shape/counts without truncating or partially applying it',
    (mutate) => {
      const f = fixture()
      f.core.tick(50)
      f.deliver()
      const state = persistentStateFor(f.core.world)
      f.client.handle(JSON.stringify({ type: 'town_state', state: mutate(state) }), 100)
      expect(f.closed()).toBe(1)
      expect(f.errors).toHaveLength(1)
      expect(f.replacements()).toBe(1)
      expect(f.client.persistent.brokenWindows.size).toBe(0)
    },
  )

  it('does not accept state before welcome or after terminal version rejection', () => {
    const f = fixture()
    const state = JSON.stringify({ type: 'town_state', state: persistentStateFor(f.core.world) })
    f.client.handle(state, 0)
    expect(f.replacements()).toBe(0)
    const welcome = f.peer.packets.find((packet) => typeof packet === 'string')
    if (typeof welcome !== 'string') {
      throw new Error('missing welcome')
    }
    f.client.handle(
      JSON.stringify({ ...JSON.parse(welcome), contractVersion: CONTRACT_VERSION - 1 }),
      0,
    )
    f.client.handle(state, 50)
    expect(f.closed()).toBe(1)
    expect(f.replacements()).toBe(0)
    expect(f.client.persistent.ready).toBe(false)
  })
})
