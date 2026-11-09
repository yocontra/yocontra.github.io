import { describe, expect, test as it } from 'bun:test'
import {
  BTN_AIM,
  BTN_FIRE,
  BTN_THROW,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../../src/experiments/out-west/contract/town.ts'
import {
  DYNAMITE_FUSE_TICKS,
  MAX_HP,
  PICKUP_RESPAWN_TICKS,
  RIFLE_ROUNDS,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { hasLineOfSight, TOWN } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import type { World } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { SimEvent } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { aimAt, place, run, runCollect, testWorld } from './test-helpers.ts'

type Shot = Extract<SimEvent, { type: 'shot' }>

const spot = (w: World, kind: string) => {
  const i = w.layout.pickups.findIndex((p) => p.kind === kind)
  const s = w.layout.pickups[i]
  if (!s) {
    throw new Error(`no ${kind} spot`)
  }
  return { i, x: s.x, z: s.z }
}

/** Shooter standing on main street with a pickup weapon in hand. */
function armed(kind: 'rifle' | 'shotgun') {
  const w = testWorld()
  const a = place(w, 20, 64)
  a.weapon = kind === 'rifle' ? WEAPON_RIFLE : WEAPON_SHOTGUN
  a.weaponRounds = kind === 'rifle' ? RIFLE_ROUNDS : 2
  return { w, a }
}

describe('map pickups', () => {
  it('walking over a spot takes the weapon; the spot respawns 45 s later', () => {
    const w = testWorld()
    const s = spot(w, 'rifle')
    const p = place(w, s.x, s.z)
    run(w, 1)
    expect(p.weapon).toBe(WEAPON_RIFLE)
    expect(p.weaponRounds).toBe(RIFLE_ROUNDS)
    expect(w.pickups[s.i]?.availableAt).toBeGreaterThan(w.tick)
    const other = place(w, s.x, s.z)
    run(w, 1)
    expect(other.weapon).toBe(WEAPON_REVOLVER)
    p.x = 30
    p.z = 64
    other.x = 30
    other.z = 66
    const ready = runCollect(w, PICKUP_RESPAWN_TICKS, {}, 'pickup_ready')
    expect(ready.length).toBe(1)
  })

  it('rifle: 60 damage at 30 m on the sights, five rounds, then back to the revolver', () => {
    const { w, a } = armed('rifle')
    const b = place(w, 50, 64)
    run(w, 1)
    const shots = runCollect(
      w,
      1,
      { [a.id]: () => ({ aim: aimAt(a, b), buttons: BTN_FIRE | BTN_AIM }) },
      'shot',
    ) as Shot[]
    expect((shots[0]?.flags ?? 0) & SHOT_RIFLE).toBeTruthy()
    expect(b.hp).toBe(MAX_HP - 60)
    a.weaponRounds = 1
    a.fireCooldownMs = 0
    run(w, 1)
    run(w, 1, { [a.id]: () => ({ aim: aimAt(a, b), buttons: BTN_FIRE }) })
    expect(a.weapon).toBe(WEAPON_REVOLVER)
    expect(a.ammo).toBe(6)
  })

  it('shotgun: close range shreds, nothing past 9 m', () => {
    const { w, a } = armed('shotgun')
    const near = place(w, 24, 64)
    const far = place(w, 32, 66)
    run(w, 1)
    const shots = runCollect(
      w,
      1,
      { [a.id]: () => ({ aim: aimAt(a, near), buttons: BTN_FIRE }) },
      'shot',
    ) as Shot[]
    expect((shots[0]?.flags ?? 0) & SHOT_SHOTGUN).toBeTruthy()
    expect(near.hp).toBeLessThanOrEqual(MAX_HP - 48)
    expect(far.hp).toBe(MAX_HP)
  })

  it('dynamite: thrown along the aim, 2 s fuse, 80 damage within 4 m behind no wall', () => {
    const w = testWorld()
    const bank = TOWN.buildings.find((building) => building.kind === 'bank')
    if (!bank) {
      throw new Error('Missing bank')
    }
    const blast = { x: bank.x + bank.w + 0.5, z: bank.z - 1.5 }
    const a = place(w, blast.x - 9.5, blast.z)
    a.dynamite = 1
    const victim = place(w, blast.x, blast.z - 1)
    const sheltered = place(w, bank.x + bank.w - 0.5, bank.z + 1)
    expect(Math.hypot(blast.x - sheltered.x, blast.z - sheltered.z)).toBeLessThan(4)
    expect(hasLineOfSight(w.grid, blast, victim)).toBe(true)
    expect(hasLineOfSight(w.grid, blast, sheltered)).toBe(false)
    run(w, 1)
    const thrown = runCollect(
      w,
      1,
      { [a.id]: () => ({ aim: aimAt(a, blast), buttons: BTN_THROW }) },
      'dynamite_thrown',
    )
    expect(thrown.length).toBe(1)
    expect(a.dynamite).toBe(0)
    run(w, DYNAMITE_FUSE_TICKS - 2)
    expect(victim.hp).toBe(MAX_HP)
    const blasts = runCollect(w, 3, {}, 'explosion')
    expect(blasts.length).toBe(1)
    expect(victim.hp).toBe(MAX_HP - 80)
    expect(sheltered.hp).toBe(MAX_HP)
  })

  it('dying loses the pickup weapon and the dynamite', () => {
    const { w, a } = armed('rifle')
    a.dynamite = 1
    const b = place(w, 30, 64)
    run(w, 1)
    runCollect(
      w,
      40,
      { [b.id]: (t) => ({ aim: aimAt(b, a), buttons: t % 2 === 0 ? BTN_FIRE : 0 }) },
      'kill',
    )
    expect(a.alive).toBe(false)
    expect(a.weapon).toBe(WEAPON_REVOLVER)
    expect(a.dynamite).toBe(0)
  })

  it('preserves equipped weapons, pickup cooldowns and active fuses across transient event clears', () => {
    const { w, a } = armed('rifle')
    a.dynamite = 1
    expect(a.weapon).toBe(WEAPON_RIFLE)
    expect(a.weaponRounds).toBe(5)
    const s = spot(w, 'shotgun')
    const taker = place(w, s.x, s.z)
    run(w, 1)
    run(w, 1, { [a.id]: () => ({ aim: 0, buttons: BTN_THROW }) })
    expect(taker.weapon).toBe(WEAPON_SHOTGUN)
    const unavailable = w.pickups[s.i]?.availableAt
    expect(unavailable).toBeGreaterThan(w.tick)
    expect(w.fuses).toHaveLength(1)
    const active = w.fuses[0]
    if (!active) {
      throw new Error('Expected active fuse')
    }
    const fuse = { ...active }
    run(w, 1)
    expect(w.events.some((event) => event.type === 'dynamite_thrown')).toBe(false)
    expect(w.pickups[s.i]?.availableAt).toBe(unavailable)
    expect(w.fuses).toEqual([fuse])
  })
})
