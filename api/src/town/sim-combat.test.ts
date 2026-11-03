import { describe, expect, test as it } from 'bun:test'
import {
  BTN_AIM,
  BTN_FIRE,
  BTN_RELOAD,
  BTN_ROLL,
  KILL_PARDON,
  SHOT_DEAD_EYE,
  SHOT_HIT,
} from '../../../src/experiments/out-west/contract/town.ts'
import { damageAt } from '../../../src/experiments/out-west/ffa/sim/combat.ts'
import {
  DEAD_EYE_CLOSE_TICKS,
  HOLSTER_TICKS,
  MAX_HP,
  REGEN_DELAY_TICKS,
  RELOAD_TICKS,
  SPAWN_PROTECT_TICKS,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import type { SimEvent } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { aimAt, place, run, runCollect, testWorld } from './test-helpers.ts'

type Shot = Extract<SimEvent, { type: 'shot' }>
type Kill = Extract<SimEvent, { type: 'kill' }>

/** Press fire on every other tick (press, release). */
const spam = (aim: number) => (t: number) => ({ aim, buttons: t % 2 === 0 ? BTN_FIRE : 0 })

function duel() {
  const w = testWorld()
  const a = place(w, 20, 64)
  const b = place(w, 30, 64)
  // One tick so there's history to rewind into.
  run(w, 1)
  return { w, a, b, aim: aimAt(a, b) }
}

describe('revolver', () => {
  it('34 damage per hit, three hits to kill', () => {
    const { w, a, b, aim } = duel()
    const shots = runCollect(w, 40, { [a.id]: spam(aim) }, 'shot') as Shot[]
    expect(shots.length).toBeGreaterThanOrEqual(3)
    expect(shots.slice(0, 3).every((s) => s.flags & SHOT_HIT)).toBe(true)
    expect(b.alive).toBe(false)
    expect(b.stats.deaths).toBe(1)
    expect(a.stats.kills).toBe(1)
  })

  it('six rounds, then a 1.6 s reload; fire rate averages 280 ms', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    const shots = runCollect(w, 100, { [a.id]: spam(0) }, 'shot') as Shot[]
    // 100 ticks = 5 s: 6 shots over ~1.5 s, a 1.6 s reload, then more.
    expect(a.stats.shots).toBeGreaterThan(6)
    expect(shots.length).toBe(a.stats.shots)
    const w2 = testWorld()
    const p = place(w2, 20, 64)
    const ticks: number[] = []
    for (let i = 0; i < 40; i++) {
      run(w2, 1, { [p.id]: (t) => ({ buttons: t % 2 === 0 ? BTN_FIRE : 0 }) })
      if (w2.events.some((e) => e.type === 'shot')) {
        ticks.push(w2.tick - 1)
      }
    }
    expect(ticks.length).toBe(6)
    const gaps = ticks.slice(1).map((t, i) => (t - (ticks[i] ?? 0)) * 50)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(250)
    expect(p.ammo).toBe(0)
    expect(p.reloadTicks).toBeGreaterThan(0)
    run(w2, RELOAD_TICKS + 1)
    expect(p.ammo).toBe(6)
  })

  it('holding fire is one shot (semi-automatic)', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    run(w, 30, { [a.id]: () => ({ buttons: BTN_FIRE }) })
    expect(a.stats.shots).toBe(1)
  })

  it('manual reload', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    run(w, 1, { [a.id]: () => ({ buttons: BTN_FIRE }) })
    run(w, 1, { [a.id]: () => ({ buttons: BTN_RELOAD }) })
    expect(a.reloadTicks).toBe(RELOAD_TICKS - 0)
    run(w, RELOAD_TICKS)
    expect(a.ammo).toBe(6)
  })

  it('damage falls to 60% beyond 14 m, nothing past 22 m', () => {
    expect(damageAt(10, false)).toBe(34)
    expect(damageAt(15, false)).toBeCloseTo(20.4)
    const w = testWorld()
    const a = place(w, 10, 64)
    const b = place(w, 33, 64)
    run(w, 2, { [a.id]: spam(aimAt(a, b)) })
    expect(b.hp).toBe(MAX_HP)
  })

  it('walls stop bullets', () => {
    const w = testWorld()
    // Saloon west wall at x = 47; stand either side of it.
    const a = place(w, 45.5, 40)
    const b = place(w, 50, 40)
    run(w, 2, { [a.id]: spam(aimAt(a, b)) })
    expect(b.hp).toBe(MAX_HP)
  })

  it('regenerates 12 HP/s after 5 s without damage', () => {
    const { w, a, b, aim } = duel()
    run(w, 1, { [a.id]: () => ({ aim, buttons: BTN_FIRE }) })
    expect(b.hp).toBe(66)
    run(w, REGEN_DELAY_TICKS + 20)
    expect(b.hp).toBeGreaterThan(66 + 10)
  })
})

describe('Dead-Eye', () => {
  it('aim from the holster, fire inside the 150 ms window: 68 damage and the hat comes off', () => {
    const { w, a, b, aim } = duel()
    a.lastFireTick = w.tick - HOLSTER_TICKS
    const start = w.tick
    const events: SimEvent[] = []
    for (let i = 0; i <= DEAD_EYE_CLOSE_TICKS; i++) {
      run(w, 1, {
        [a.id]: (t) => ({
          aim,
          buttons: BTN_AIM | (t === start + DEAD_EYE_CLOSE_TICKS ? BTN_FIRE : 0),
        }),
      })
      events.push(...w.events)
    }
    const shot = events.find((e): e is Shot => e.type === 'shot')
    expect(shot && shot.flags & SHOT_DEAD_EYE).toBeTruthy()
    expect(b.hp).toBe(MAX_HP - 68)
    expect(b.hatless).toBe(true)
  })

  it('firing early is a normal shot', () => {
    const { w, a, b, aim } = duel()
    a.lastFireTick = w.tick - HOLSTER_TICKS
    run(w, 3, { [a.id]: () => ({ aim, buttons: BTN_AIM }) })
    run(w, 1, { [a.id]: () => ({ aim, buttons: BTN_AIM | BTN_FIRE }) })
    expect(b.hp).toBe(MAX_HP - 34)
  })

  it('waiting too long is a normal shot', () => {
    const { w, a, b, aim } = duel()
    a.lastFireTick = w.tick - HOLSTER_TICKS
    run(w, 14, { [a.id]: () => ({ aim, buttons: BTN_AIM }) })
    run(w, 1, { [a.id]: () => ({ aim, buttons: BTN_AIM | BTN_FIRE }) })
    expect(b.hp).toBe(MAX_HP - 34)
  })

  it('no Dead-Eye with the gun out', () => {
    const { w, a, b, aim } = duel()
    a.lastFireTick = w.tick
    run(w, DEAD_EYE_CLOSE_TICKS, { [a.id]: () => ({ aim, buttons: BTN_AIM }) })
    run(w, 1, { [a.id]: () => ({ aim, buttons: BTN_AIM | BTN_FIRE }) })
    expect(b.hp).toBe(MAX_HP - 34)
  })
})

describe('roll i-frames, spawn protection and the pardon', () => {
  it('a rolling target takes no damage during the i-frames', () => {
    const { w, a, b, aim } = duel()
    run(w, 1, { [b.id]: () => ({ moveZ: 127, buttons: BTN_ROLL }) })
    run(w, 1, {
      [a.id]: () => ({ aim: aimAt(a, b), buttons: BTN_FIRE }),
      [b.id]: () => ({ buttons: BTN_ROLL }),
    })
    expect(b.hp).toBe(MAX_HP)
    expect(aim).toBeGreaterThanOrEqual(0)
  })

  it('spawn protection blocks damage; firing ends it early', () => {
    const { w, a, b, aim } = duel()
    b.protectUntil = w.tick + SPAWN_PROTECT_TICKS
    run(w, 1, { [a.id]: spam(aim) })
    expect(b.hp).toBe(MAX_HP)
    run(w, 1, { [b.id]: () => ({ buttons: BTN_FIRE }) })
    expect(b.protectUntil).toBeLessThanOrEqual(w.tick)
    run(w, 8, { [a.id]: spam(aim) })
    expect(b.hp).toBeLessThan(MAX_HP)
  })

  it('the protected player cannot damage anyone (their first shot ends protection, then hits)', () => {
    const { w, a, b } = duel()
    a.protectUntil = w.tick + SPAWN_PROTECT_TICKS
    run(w, 1, { [a.id]: () => ({ aim: aimAt(a, b), buttons: BTN_FIRE }) })
    expect(a.protectUntil).toBeLessThanOrEqual(w.tick)
  })

  it("killed within 8 s of spawning: the Sheriff's pardon (no bounty, no drop)", () => {
    const { w, a, b, aim } = duel()
    b.spawnTick = w.tick
    b.carried = 120
    const kills = runCollect(w, 40, { [a.id]: spam(aim) }, 'kill') as Kill[]
    expect((kills[0]?.flags ?? 0) & KILL_PARDON).toBeTruthy()
    expect(a.carried).toBe(0)
    expect(a.stats.xp).toBe(0)
    expect(w.bags.length).toBe(0)
  })

  it('respawn after the 3 s death cam with 3 s of protection', () => {
    const { w, a, b, aim } = duel()
    run(w, 40, { [a.id]: spam(aim) })
    expect(b.alive).toBe(false)
    run(w, 60)
    expect(b.alive).toBe(true)
    expect(b.hp).toBe(MAX_HP)
    expect(b.protectUntil).toBeGreaterThan(w.tick)
  })
})

describe('lag compensation', () => {
  it('a shot rewinds the target to where the shooter saw it, up to 200 ms', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    const b = place(w, 30, 64)
    // B runs north for 6 ticks (1.65 m): out of the line A is aiming down.
    run(w, 6, { [b.id]: () => ({ moveZ: -127 }) })
    const seenAt = w.tick - 4
    const aim = aimAt(a, { x: 30, z: 64 - 0.275 * (seenAt + 1) })
    run(w, 1, { [a.id]: () => ({ aim, buttons: BTN_FIRE, viewTime: seenAt }) })
    expect(b.hp).toBe(MAX_HP - 34)
  })

  it('claims older than 200 ms are clamped (and miss)', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    const b = place(w, 30, 64)
    run(w, 12, { [b.id]: () => ({ moveZ: -127 }) })
    const aim = aimAt(a, { x: 30, z: 64 })
    run(w, 1, { [a.id]: () => ({ aim, buttons: BTN_FIRE, viewTime: w.tick - 12 }) })
    expect(b.hp).toBe(MAX_HP)
  })
})
