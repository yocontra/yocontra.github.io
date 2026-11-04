/** Wire v5 movement and gunplay: sprint, sprint-to-fire, crouch, slide, the sights, jump, spread. */
import { describe, expect, test as it } from 'bun:test'
import {
  BTN_AIM,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_JUMP,
  BTN_SPRINT,
  WEAPON_REVOLVER,
  WEAPON_SHOTGUN,
} from '../../../src/experiments/out-west/contract/town.ts'
import {
  ADS_SPEED_FACTOR,
  CROUCH_SPEED,
  RUN_SPEED,
  SLIDE_COOLDOWN_TICKS,
  SPRINT_OUT_TICKS,
  SPRINT_SPEED,
  TICK_HZ,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { buildGrid } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { inIframes, stepMove } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import { spreadDeg } from '../../../src/experiments/out-west/ffa/sim/spread.ts'
import type { MoveState } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { aimAt, place, run, testWorld } from './test-helpers.ts'

const grid = buildGrid()
const state = (x: number, z: number): MoveState => ({
  x,
  z,
  y: 0,
  roof: 0,
  climbTicks: 0,
  climbDeck: 0,
  climbDir: 0,
  fallTicks: 0,
  fallTotal: 0,
  fallFromX: 0,
  fallFromZ: 0,
  fallFromY: 0,
  fallToX: 0,
  fallToZ: 0,
  rollTicks: 0,
  rollCooldown: 0,
  rollDirX: 0,
  rollDirZ: 0,
  jumpTicks: 0,
  jumpCooldown: 0,
  vaultStep: 0,
  vaultAim: 0,
  sprinting: false,
  sprintLock: 0,
  sprintOut: 0,
  slideTicks: 0,
  slideCooldown: 0,
  slideAim: 0,
  airX: 0,
  airZ: 0,
})
// biome-ignore lint/complexity/useMaxParams: a test helper with stick defaults
const go = (m: MoveState, ticks: number, buttons: number, moveX = 127, moveZ = 0) => {
  let prev = 0
  for (let i = 0; i < ticks; i++) {
    stepMove(grid, m, { moveX, moveZ, aim: 0, buttons, prevButtons: prev, canMove: true })
    prev = buttons
  }
}

describe('v5 movement', () => {
  it('sprints at 7.6 m/s along the aim, not sideways or backwards', () => {
    const m = state(20, 64)
    go(m, TICK_HZ, BTN_SPRINT)
    expect(m.x - 20).toBeCloseTo(SPRINT_SPEED, 1)
    expect(m.sprinting).toBe(true)
    const side = state(20, 60)
    go(side, TICK_HZ, BTN_SPRINT, 0, 127)
    expect(side.z - 60).toBeCloseTo(RUN_SPEED, 1)
    expect(side.sprinting).toBe(false)
  })

  it('crouch and the sights slow you', () => {
    const c = state(20, 64)
    go(c, TICK_HZ, BTN_CROUCH)
    expect(c.x - 20).toBeCloseTo(CROUCH_SPEED, 1)
    const a = state(20, 64)
    go(a, TICK_HZ, BTN_AIM)
    expect(a.x - 20).toBeCloseTo(RUN_SPEED * ADS_SPEED_FACTOR, 1)
    const s = state(20, 64)
    go(s, TICK_HZ, BTN_AIM | BTN_SPRINT)
    expect(s.sprinting).toBe(false)
  })

  it('crouch mid-sprint slides about 4.4 m with i-frames up front, then a cooldown', () => {
    const m = state(14, 64)
    go(m, 4, BTN_SPRINT)
    const x0 = m.x
    stepMove(grid, m, {
      moveX: 127,
      moveZ: 0,
      aim: 0,
      buttons: BTN_SPRINT | BTN_CROUCH,
      prevButtons: BTN_SPRINT,
      canMove: true,
    })
    expect(m.slideTicks).toBeGreaterThan(0)
    expect(inIframes(m)).toBe(true)
    let ticks = 1
    while (m.slideTicks > 0) {
      go(m, 1, BTN_CROUCH, 0, 0)
      ticks++
    }
    expect(m.x - x0).toBeGreaterThan(3.8)
    expect(m.x - x0).toBeLessThan(5)
    expect(ticks).toBe(13)
    expect(m.slideCooldown).toBeGreaterThan(0)
    expect(m.slideCooldown).toBeLessThan(SLIDE_COOLDOWN_TICKS)
  })

  it('a jump keeps its take-off speed and steers only a little', () => {
    const m = state(14, 64)
    go(m, 4, BTN_SPRINT)
    stepMove(grid, m, {
      moveX: 127,
      moveZ: 0,
      aim: 0,
      buttons: BTN_SPRINT | BTN_JUMP,
      prevButtons: BTN_SPRINT,
      canMove: true,
    })
    expect(m.jumpTicks).toBeGreaterThan(0)
    const x0 = m.x
    // stick pulled back in the air: momentum carries on
    go(m, 4, 0, -127, 0)
    expect(m.x).toBeGreaterThan(x0 + 0.5)
  })
})

describe('v5 gunplay', () => {
  it('a trigger pull mid-sprint fires once the gun is up', () => {
    const w = testWorld()
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

  it('anim byte carries the stance bits', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    run(w, 1, { [a.id]: () => ({ buttons: BTN_CROUCH | BTN_AIM }) })
    expect(a.crouched).toBe(true)
    expect(a.ads).toBe(true)
  })
})
