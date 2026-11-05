import { describe, expect, test as it } from 'bun:test'
import { BTN_AIM, BTN_FIRE, BTN_JUMP } from '../../../src/experiments/out-west/contract/town.ts'
import { FALL_DAMAGE_MIN, MAX_HP } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { aimAt, place, run, testWorld } from './test-helpers.ts'

describe('2.5D movement', () => {
  it('mantles onto a crate and stands on it', () => {
    const w = testWorld()
    const p = place(w, 64, 70)
    run(w, 10, { [p.id]: () => ({ moveX: 127 }) })
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_JUMP }) })
    run(w, 10, { [p.id]: () => ({}) })
    expect(p.y).toBeCloseTo(0.75, 2)
    expect(p.grounded).toBe(true)
  })

  it('mantles onto a crate stack', () => {
    const w = testWorld()
    const p = place(w, 20.5, 57.5)
    run(w, 20, { [p.id]: () => ({ moveX: 127 }) })
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_JUMP }) })
    run(w, 10, { [p.id]: () => ({}) })
    expect(p.y).toBeCloseTo(2.2, 2)
    expect(p.grounded).toBe(true)
  })

  it('walks under a porch roof, then stands on it via the catwalk ladder', () => {
    const w = testWorld()
    const under = place(w, 50, 55.2)
    run(w, 2)
    expect(under.y).toBeCloseTo(0.06, 2)
    // The roof is above the head, not a wall.
    expect(under.y + 1.8).toBeLessThan(3.16)
  })

  it('steps up the boardwalk without jumping', () => {
    const w = testWorld()
    const p = place(w, 50, 57)
    run(w, 20, { [p.id]: () => ({ moveZ: -127 }) })
    expect(p.y).toBeCloseTo(0.06, 2)
  })

  it('takes damage past a three-storey fall', () => {
    const w = testWorld()
    const p = place(w, 20, 64)
    p.y = 12
    p.support = 0
    p.grounded = false
    p.vy = 0
    p.airPeakY = 12
    run(w, 80)
    expect(p.y).toBe(0)
    expect(p.hp).toBeLessThan(MAX_HP)
    expect(p.hp).toBe(MAX_HP - Math.round((12 - FALL_DAMAGE_MIN) * 10))
  })

  it('does not hurt a fall under three storeys', () => {
    const w = testWorld()
    const p = place(w, 20, 64)
    p.y = 9
    p.support = 0
    p.grounded = false
    p.vy = 0
    p.airPeakY = 9
    run(w, 60)
    expect(p.hp).toBe(MAX_HP)
  })

  it('a pitched shot hits an elevated rider', () => {
    const w = testWorld()
    const high = place(w, 20, 64)
    high.y = 4
    high.support = 4
    high.grounded = true
    high.airPeakY = 4
    const low = place(w, 30, 64)
    run(w, 1)
    run(w, 1, {
      [low.id]: () => ({ aim: aimAt(low, high), pitch: 28, buttons: BTN_FIRE | BTN_AIM }),
    })
    expect(high.hp).toBeLessThan(MAX_HP)
  })
})
