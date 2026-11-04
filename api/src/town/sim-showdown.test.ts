import { describe, expect, test as it } from 'bun:test'
import {
  BTN_CALLOUT,
  BTN_FIRE,
  SD_COWARD,
  SD_FROZE,
  SD_WIN,
} from '../../../src/experiments/out-west/contract/town.ts'
import {
  CALLOUT_ACCEPT_TICKS,
  MAX_HP,
  SHOWDOWN_MAX_TICKS,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { resolveShowdown } from '../../../src/experiments/out-west/ffa/sim/showdown.ts'
import { createWorld } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame, SimEvent } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { addPlayer, step } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { BotDirector } from './bots.ts'
import { aimAt, place, run, runCollect, testWorld } from './test-helpers.ts'

type End = Extract<SimEvent, { type: 'showdown_end' }>

function calledOut() {
  const w = testWorld()
  const a = place(w, 20, 64, { carried: 100 })
  const b = place(w, 28, 64, { carried: 200 })
  run(w, 1)
  run(w, 1, { [a.id]: () => ({ aim: aimAt(a, b), buttons: BTN_CALLOUT }) })
  return { w, a, b }
}

describe('Call Out', () => {
  it('challenges the calm, solvent player in your aim within 12 m', () => {
    const { w, a, b } = calledOut()
    expect(b.calledBy).toBe(a.id)
    expect(w.events.some((e) => e.type === 'callout')).toBe(true)
  })

  it('refuses targets under $50, out of range, or recently hurt', () => {
    const w = testWorld()
    const a = place(w, 20, 64, { carried: 100 })
    const poor = place(w, 26, 64, { carried: 10 })
    const far = place(w, 20, 80, { carried: 100 })
    run(w, 1)
    run(w, 1, { [a.id]: () => ({ aim: aimAt(a, poor), buttons: BTN_CALLOUT }) })
    run(w, 1, { [a.id]: () => ({ aim: aimAt(a, far), buttons: 0 }) })
    expect(poor.calledBy).toBe(255)
    expect(far.calledBy).toBe(255)
  })

  it('accepting forms a ring: both frozen and invulnerable to third parties', () => {
    const { w, a, b } = calledOut()
    run(w, 1, { [b.id]: () => ({ buttons: BTN_CALLOUT }) })
    expect(a.showdown).toBeGreaterThan(0)
    expect(b.showdown).toBe(a.showdown)
    const x = a.x
    run(w, 5, { [a.id]: () => ({ moveX: 127 }) })
    expect(a.x).toBe(x)
    const third = place(w, 24, 70)
    run(w, 1, { [third.id]: () => ({ aim: aimAt(third, a), buttons: BTN_FIRE }) })
    expect(a.hp).toBe(MAX_HP)
  })

  it('an unanswered call-out lapses after 3 s', () => {
    const { w, b } = calledOut()
    run(w, CALLOUT_ACCEPT_TICKS + 1)
    run(w, 1, { [b.id]: () => ({ buttons: BTN_CALLOUT }) })
    expect(b.showdown).toBe(-1)
  })

  it('firing before the bell is cowardice: the coward dies and drops everything', () => {
    const { w, a, b } = calledOut()
    run(w, 1, { [b.id]: () => ({ buttons: BTN_CALLOUT }) })
    const ends = runCollect(
      w,
      2,
      { [a.id]: () => ({ buttons: BTN_FIRE }) },
      'showdown_end',
    ) as End[]
    expect(ends[0]?.outcome).toBe(SD_COWARD)
    expect(ends[0]?.winner).toBe(b.id)
    expect(a.alive).toBe(false)
    expect(w.bags[0]?.amount).toBe(100)
    expect(w.burned).toBe(0)
  })

  it('the bell rings, the judge picks a winner: the loser dies with a 100% drop, the winner gets 60 XP', () => {
    const { w, a, b } = calledOut()
    run(w, 1, { [b.id]: () => ({ buttons: BTN_CALLOUT }) })
    const id = a.showdown
    const calls = runCollect(w, 80, {}, 'showdown_call')
    expect(calls.length).toBe(1)
    resolveShowdown(w, id, { kind: 'win', winner: b.id, winnerMs: 212 })
    const end = w.events.find((e): e is End => e.type === 'showdown_end')
    expect(end?.outcome).toBe(SD_WIN)
    expect(a.alive).toBe(false)
    expect(w.bags[0]?.amount).toBe(100)
    expect(b.stats.xp).toBeGreaterThanOrEqual(60)
    expect(b.showdown).toBe(-1)
  })

  it('no verdict: the ring breaks after 6 s with both alive', () => {
    const { w, a, b } = calledOut()
    run(w, 1, { [b.id]: () => ({ buttons: BTN_CALLOUT }) })
    const ends = runCollect(w, SHOWDOWN_MAX_TICKS + 1, {}, 'showdown_end') as End[]
    expect(ends[0]?.outcome).toBe(SD_FROZE)
    expect(a.alive && b.alive).toBe(true)
  })
})

describe('determinism', () => {
  function playthrough(seed: number): string {
    const w = createWorld({ seed })
    const bots = new BotDirector(seed)
    for (let i = 0; i < 24; i++) {
      addPlayer(w, { accountId: `b${i}`, name: 'b', level: 1 + i, prestige: 0, bot: i % 2 === 0 })
    }
    for (let t = 0; t < 1200; t++) {
      const frames: (InputFrame | null)[] = []
      bots.frames(w, frames)
      step(w, frames)
    }
    return JSON.stringify(
      w.players.map((p) => p && [p.x, p.z, p.hp, p.carried, p.stats.kills, p.stats.deaths, p.ammo]),
    )
  }

  it('same seed and inputs, same world', () => {
    expect(playthrough(5)).toBe(playthrough(5))
    expect(playthrough(5)).not.toBe(playthrough(6))
  })
})
