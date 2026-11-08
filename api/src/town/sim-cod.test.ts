import { describe, expect, test as it } from 'bun:test'
import {
  BTN_AIM,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_SPRINT,
  WEAPON_REVOLVER,
  WEAPON_SHOTGUN,
} from '../../../src/experiments/out-west/contract/town.ts'
import { SPRINT_OUT_TICKS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { spreadDeg } from '../../../src/experiments/out-west/ffa/sim/spread.ts'
import { aimAt, place, run } from './test-helpers.ts'
import { nativeTestWorld } from './testing/native.ts'

describe('native movement and gunplay', () => {
  it('a trigger pull mid-sprint fires once the gun is up', async () => {
    const w = await nativeTestWorld()
    const a = place(w, 20, 64)
    const b = place(w, 30, 64)
    const aim = aimAt(a, b)
    run(w, 4, { [a.id]: () => ({ moveX: 127, aim, buttons: BTN_SPRINT }) })
    expect(a.sprinting).toBe(true)
    let firedAt = -1
    for (let i = 0; i < 8 && firedAt < 0; i++) {
      run(w, 1, {
        [a.id]: () => ({ moveX: 127, aim, buttons: BTN_SPRINT | (i === 0 ? BTN_FIRE : 0) }),
      })
      if (w.events.some((e) => e.type === 'shot')) {
        firedAt = i
      }
    }
    expect(firedAt).toBe(SPRINT_OUT_TICKS)
    expect(a.sprinting).toBe(false)
  })

  it('the sights are tighter than the hip; moving, jumping and bloom open it', () => {
    const base = {
      weapon: WEAPON_REVOLVER,
      ads: false,
      crouched: false,
      moving: false,
      sliding: false,
      airborne: false,
      bloom: 0,
    }
    const hip = spreadDeg(base)
    expect(spreadDeg({ ...base, ads: true })).toBeLessThan(hip / 4)
    expect(spreadDeg({ ...base, moving: true })).toBeGreaterThan(hip)
    expect(spreadDeg({ ...base, airborne: true })).toBeGreaterThan(
      spreadDeg({ ...base, moving: true }),
    )
    expect(spreadDeg({ ...base, crouched: true })).toBeLessThan(hip)
    expect(spreadDeg({ ...base, bloom: 2 })).toBeGreaterThan(hip)
    expect(spreadDeg({ ...base, weapon: WEAPON_SHOTGUN, ads: true })).toBeLessThan(
      spreadDeg({ ...base, weapon: WEAPON_SHOTGUN }),
    )
  })

  it('replicates crouch and ADS stance', async () => {
    const w = await nativeTestWorld()
    const a = place(w, 20, 64)
    run(w, 1, { [a.id]: () => ({ buttons: BTN_CROUCH | BTN_AIM }) })
    expect(a.crouched).toBe(true)
    expect(a.ads).toBe(true)
  })
})
