import { describe, expect, it } from 'bun:test'
import { Group } from 'three'
import { NONE } from '../src/experiments/out-west/contract/town.ts'
import type { Fuse } from '../src/experiments/out-west/ffa/client/event-sounds.ts'
import type { Callout, Showdown } from '../src/experiments/out-west/ffa/client/events.ts'
import { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import { PersistentTownState } from '../src/experiments/out-west/ffa/client/persistent-state.ts'
import { Pickups } from '../src/experiments/out-west/ffa/scene/pickups.ts'
import { TICK_MS } from '../src/experiments/out-west/ffa/sim/constants.ts'

const invoke = (method: string, state: object, ...args: unknown[]) =>
  Reflect.apply(Reflect.get(FrontierGame.prototype, method), state, args)

function fixture() {
  const panes: number[][] = []
  const pickupStates: unknown[][] = []
  const music: number[] = []
  const persistent = new PersistentTownState()
  const state = {
    net: { persistent, lastTick: 100, you: 0 },
    town: { setBrokenWindows: (indices: number[]) => panes.push(indices) },
    pickups: { reconcile: (...args: unknown[]) => pickupStates.push(args) },
    fx: { bags: new Map<number, { born: number; mine: boolean; color: number }>() },
    showdowns: new Map<number, Showdown>(),
    callouts: [] as Callout[],
    riders: { isBlocked: (id: number) => id === 4 },
    fuses: new Map<number, Fuse>(),
    audio: { musicLevel: (db: number) => music.push(db) },
    syncRoster: () => undefined,
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  return { state, panes, pickupStates, music }
}

describe('Frontier ongoing presentation reconciliation', () => {
  it('restores exact current state, deadlines and phases without replaying historical effects', () => {
    const f = fixture()
    const state = f.state.net.persistent
    state.replace({
      tick: 100,
      bags: [
        {
          id: 2,
          x: 12,
          z: 18,
          amount: 30,
          style: 1,
          exclusiveFor: 0,
          exclusiveUntil: 110,
          expiresAt: 300,
        },
        {
          id: 3,
          x: 13,
          z: 18,
          amount: 40,
          style: 2,
          exclusiveFor: NONE,
          exclusiveUntil: 0,
          expiresAt: 99,
        },
      ],
      unavailablePickups: [1],
      brokenWindows: [0, 295],
      callouts: [
        { challenger: 1, target: 0, untilTick: 120 },
        { challenger: 4, target: 3, untilTick: 130 },
        { challenger: 3, target: 2, untilTick: 99 },
      ],
      showdowns: [
        { id: 7, a: 0, b: 1, cx: 50, cz: 51, calledTick: null },
        { id: 8, a: 2, b: 3, cx: 60, cz: 61, calledTick: 96 },
      ],
      fuses: [{ player: 1, x: 20, z: 30, explodeAt: 120 }],
    })
    f.state.showdowns.set(7, {
      id: 7,
      opponent: 1,
      cx: 50,
      cz: 51,
      called: false,
      callAt: 0,
      shot: true,
    })
    f.state.fx.bags.set(99, { born: 0, mine: false, color: 0 })
    const before = performance.now()
    invoke('reconcilePersistent', f.state)
    const after = performance.now()
    expect(f.panes).toEqual([[0, 295]])
    expect(f.pickupStates[0]?.slice(0, 1)).toEqual([new Set([1])])
    expect([...f.state.fx.bags.keys()]).toEqual([2])
    const bag = f.state.fx.bags.get(2)
    expect(bag?.mine).toBe(true)
    expect(bag?.born).toBeLessThanOrEqual(after / 1000 - 1)
    expect(bag?.color).toBeGreaterThan(0)
    expect(f.state.showdowns.get(7)).toMatchObject({
      called: false,
      callAt: 0,
      shot: true,
      opponent: 1,
    })
    const called = f.state.showdowns.get(8)
    expect(called).toMatchObject({ called: true, opponent: NONE })
    expect(called?.callAt).toBeGreaterThanOrEqual(before - 4 * TICK_MS)
    expect(called?.callAt).toBeLessThanOrEqual(after - 4 * TICK_MS)
    expect(f.state.callouts).toHaveLength(1)
    expect(f.state.callouts[0]?.until).toBeGreaterThanOrEqual(before + 20 * TICK_MS)
    // Absence is authoritative, including restoring panes, pickups and the town music.
    state.replace({
      tick: 101,
      bags: [],
      unavailablePickups: [],
      brokenWindows: [],
      callouts: [],
      showdowns: [],
      fuses: [],
    })
    invoke('reconcilePersistent', f.state)
    expect(f.panes.at(-1)).toEqual([])
    expect(f.state.fx.bags.size).toBe(0)
    expect(f.state.showdowns.size).toBe(0)
    expect(f.state.callouts).toEqual([])
    expect(f.music).toEqual([0])
  })

  it('preserves active live fuse audio, stops absent fuses and clears audio on a new welcome', () => {
    const f = fixture()
    const stopped: number[] = []
    const fuse = (id: number): Fuse => ({
      loop: { stop: () => stopped.push(id), set: () => undefined },
      timer: setTimeout(() => undefined, 10_000),
    })
    f.state.fuses.set(1, fuse(1))
    f.state.fuses.set(2, fuse(2))
    f.state.net.persistent.replace({
      tick: 100,
      bags: [],
      unavailablePickups: [],
      brokenWindows: [],
      callouts: [],
      showdowns: [],
      fuses: [{ player: 1, x: 20, z: 30, explodeAt: 120 }],
    })
    try {
      invoke('reconcilePersistent', f.state)
      expect(stopped).toEqual([2])
      expect([...f.state.fuses.keys()]).toEqual([1])
      invoke('onWelcome', f.state)
      expect(stopped).toEqual([2, 1])
      expect(f.state.fuses.size).toBe(0)
      expect(f.music).toEqual([0])
    } finally {
      for (const active of f.state.fuses.values()) {
        clearTimeout(active.timer)
      }
    }
  })

  it('restores landed dynamite with remaining absolute fuse time and exactly resets pickups', () => {
    const root = new Group()
    const item = new Group()
    root.add(item)
    const state = {
      root,
      template: new Group(),
      items: [{ obj: item }],
      available: [true],
      thrown: [],
    }
    Object.setPrototypeOf(state, Pickups.prototype)
    const reconcile = Reflect.get(Pickups.prototype, 'reconcile')
    Reflect.apply(reconcile, state, [
      new Set([0]),
      [
        { player: 1, x: 20, z: 30, explodeAt: 120 },
        { player: 2, x: 30, z: 40, explodeAt: 99 },
      ],
      100,
      10,
    ])
    expect(item.visible).toBe(false)
    expect(root.children).toHaveLength(2)
    expect(root.children[1]?.position.x).toBe(20)
    expect(root.children[1]?.position.z).toBe(30)
    const warnings: number[][] = []
    Reflect.apply(Pickups.prototype.eachFuse, state, [
      10,
      (...args: number[]) => warnings.push(args),
    ])
    expect(warnings).toEqual([[20, 30, (20 * TICK_MS) / 1000, 2]])
    Reflect.apply(reconcile, state, [new Set(), [], 101, 10.05])
    expect(item.visible).toBe(true)
    expect(root.children).toEqual([item])
  })
})

describe('Frontier initial persistent-state readiness', () => {
  it.each(['ready', 'disposed', 'refused', 'closed'])(
    'waits for authoritative state or stops when %s',
    async (outcome) => {
      let prepared = 0
      let precast = 0
      const cancelled = globalThis.cancelAnimationFrame
      Reflect.set(globalThis, 'cancelAnimationFrame', () => undefined)
      const state = {
        crowd: {
          prepareLooks: () => {
            prepared++
            return Promise.resolve()
          },
          precast: () => {
            precast++
            return Promise.resolve()
          },
        },
        net: {
          roster: new Map([
            [0, {}],
            [1, {}],
          ]),
          persistent: { ready: false },
          views: () => [],
          renderTick: () => 0,
        },
        disposed: false,
        exited: false,
        running: false,
        hiddenTimer: null,
        desk: { enabled: true, unlock: () => undefined },
        syncRoster: () => undefined,
        nearCap: () => 3,
        opts: { onExit: () => undefined },
      }
      Object.setPrototypeOf(state, FrontierGame.prototype)
      try {
        const pending = invoke('precastRiders', state, () => undefined)
        expect(prepared).toBe(0)
        expect(precast).toBe(0)
        if (outcome === 'ready') {
          state.net.persistent.ready = true
        } else if (outcome === 'disposed') {
          state.disposed = true
        } else if (outcome === 'refused') {
          invoke('refuseJoin', state)
        } else {
          invoke('onTransport', state, 'closed')
        }
        await pending
        expect(prepared).toBe(outcome === 'ready' ? 1 : 0)
        expect(precast).toBe(outcome === 'ready' ? 1 : 0)
      } finally {
        if (cancelled === undefined) {
          Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
        } else {
          Reflect.set(globalThis, 'cancelAnimationFrame', cancelled)
        }
      }
    },
  )
})
