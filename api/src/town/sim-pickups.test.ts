import { describe, expect, test as it } from 'bun:test'
import {
  BTN_AIM,
  BTN_FIRE,
  BTN_THROW,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  selfWeapon,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../../src/experiments/out-west/contract/town.ts'
import { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import { decodeSnapshot, type EntityView } from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import {
  DYNAMITE_FUSE_TICKS,
  MAX_HP,
  PICKUP_RESPAWN_TICKS,
  RIFLE_ROUNDS,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  ClientStream,
  persistentStateFor,
  selfView,
  snapshotFor,
} from '../../../src/experiments/out-west/ffa/sim/snapshot.ts'
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
    const a = place(w, 20, 64)
    a.dynamite = 1
    const victim = place(w, 30, 65)
    const sheltered = place(w, 45.5, 40)
    run(w, 1)
    const thrown = runCollect(
      w,
      1,
      { [a.id]: () => ({ aim: aimAt(a, { x: 30, z: 64 }), buttons: BTN_THROW }) },
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

  it('carries weapons in self and persistent pickups/fuses outside transient event history', () => {
    const { w, a } = armed('rifle')
    a.dynamite = 1
    expect(selfWeapon(selfView(w, a).weapon)).toEqual({
      weapon: WEAPON_RIFLE,
      rounds: 5,
      dynamite: true,
    })
    const s = spot(w, 'shotgun')
    const taker = place(w, s.x, s.z)
    run(w, 1)
    run(w, 1, { [a.id]: () => ({ aim: 0, buttons: BTN_THROW }) })
    expect(taker.weapon).toBe(WEAPON_SHOTGUN)
    const snap = decodeSnapshot(
      snapshotFor(
        w,
        { viewer: a, stream: new ClientStream() },
        { banked: 0, events: [] },
        new Writer(),
      ),
      new Map<number, EntityView>(),
    )
    expect(snap?.events).toEqual([])
    const persistent = persistentStateFor(w)
    expect(persistent.unavailablePickups).toContain(s.i)
    expect(persistent.fuses).toEqual(
      w.fuses.map((fuse) => ({
        player: fuse.by,
        x: fuse.x,
        z: fuse.z,
        explodeAt: fuse.explodeAt,
      })),
    )
    expect(persistent.fuses).toHaveLength(1)
  })
})
