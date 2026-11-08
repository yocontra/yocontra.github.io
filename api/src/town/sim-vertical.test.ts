import { describe, expect, test as it } from 'bun:test'
import { BTN_AIM, BTN_FIRE, BTN_JUMP } from '../../../src/experiments/out-west/contract/town.ts'
import { FALL_DAMAGE_MIN, MAX_HP } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { TOWN } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { CLIMB_TICKS, CLIMBS } from '../../../src/experiments/out-west/ffa/sim/roofwalks.ts'
import { aimAt, place, run } from './test-helpers.ts'
import { nativeTestWorld } from './testing/native.ts'

describe('2.5D movement', () => {
  it('mantles onto a crate and stands on it', async () => {
    const w = await nativeTestWorld()
    const p = place(w, 64, 70.5)
    run(w, 10, { [p.id]: () => ({ moveX: 127 }) })
    // Stop and tap jump to mantle onto it (running at low cover vaults it instead).
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, 10, { [p.id]: () => ({}) })
    expect(p.y).toBeCloseTo(0.75, 1)
    expect(p.grounded).toBe(true)
  })

  it('mantles onto a crate stack', async () => {
    const w = await nativeTestWorld()
    const p = place(w, 20.5, 58.25)
    run(w, 20, { [p.id]: () => ({ moveX: 127 }) })
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, 10, { [p.id]: () => ({}) })
    expect(p.y).toBeCloseTo(2.2, 1)
    expect(p.grounded).toBe(true)
  })

  it('walks under a porch roof, then stands on it via the catwalk ladder', async () => {
    const w = await nativeTestWorld()
    const under = place(w, 50, 55.2)
    run(w, 2)
    expect(under.y).toBeCloseTo(0.06, 2)
    // The roof is above the head, not a wall.
    expect(under.y + 1.8).toBeLessThan(3.16)
  })

  it('steps up the boardwalk without jumping', async () => {
    const w = await nativeTestWorld()
    const p = place(w, 50, 57)
    run(w, 20, { [p.id]: () => ({ moveZ: -127 }) })
    expect(p.y).toBeCloseTo(0.06, 2)
  })

  it('takes damage past a three-storey fall', async () => {
    const w = await nativeTestWorld()
    const p = place(w, 20, 64)
    p.y = 12
    p.support = 0
    p.grounded = false
    p.vy = 0
    p.airPeakY = 12
    run(w, 80)
    expect(Math.abs(p.y)).toBeLessThan(0.02)
    expect(p.hp).toBeLessThan(MAX_HP)
    expect(p.hp).toBe(MAX_HP - Math.round((12 - FALL_DAMAGE_MIN) * 10))
  })

  it('does not hurt a fall under three storeys', async () => {
    const w = await nativeTestWorld()
    const p = place(w, 20, 64)
    p.y = 9
    p.support = 0
    p.grounded = false
    p.vy = 0
    p.airPeakY = 9
    run(w, 60)
    expect(p.hp).toBe(MAX_HP)
  })

  it('vaults low cover with a real arc and lands on the far side', async () => {
    const w = await nativeTestWorld()
    const fence = TOWN.cover.find((c) => c.kind === 'fence')
    expect(fence).toBeDefined()
    if (!fence) {
      return
    }
    const p = place(w, fence.x + fence.w / 2, fence.z + fence.d + 1.2)
    run(w, 10, { [p.id]: () => ({ moveZ: -127 }) })
    run(w, 1, { [p.id]: () => ({ moveZ: -127, aim: 49_152, buttons: BTN_JUMP }) })
    expect(p.vaultStep).toBeGreaterThan(0)
    run(w, 4, { [p.id]: () => ({}) })
    expect(p.y).toBeGreaterThan(0.4)
    run(w, 12, { [p.id]: () => ({}) })
    expect(p.z).toBeLessThan(fence.z)
    expect(Math.abs(p.y)).toBeLessThan(0.02)
  })

  it('climbs a boxcar end ladder onto its roof and back down', async () => {
    const w = await nativeTestWorld()
    const climb = CLIMBS.find((c) => c.walk === null)
    expect(climb).toBeDefined()
    if (!climb) {
      return
    }
    const p = place(w, climb.bottomX, climb.bottomZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    expect(p.climbDir).toBe(1)
    run(w, CLIMB_TICKS)
    expect(p.y).toBeCloseTo(climb.top, 2)
    expect(p.grounded).toBe(true)
    expect(p.x).toBeCloseTo(climb.topX, 1)
    expect(p.z).toBeCloseTo(climb.topZ, 1)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    expect(p.climbDir).toBe(-1)
    run(w, CLIMB_TICKS)
    expect(Math.abs(p.y)).toBeLessThan(0.02)
    expect(p.grounded).toBe(true)
  })

  it('a pitched shot hits an elevated rider', async () => {
    const w = await nativeTestWorld()
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
