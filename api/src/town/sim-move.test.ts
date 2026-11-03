import { describe, expect, test } from 'bun:test'
import { BTN_ROLL } from '../../../src/experiments/out-west/contract/town.ts'
import {
  ROLL_COOLDOWN_TICKS,
  ROLL_DISTANCE,
  RUN_SPEED,
  TICK_HZ,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { buildGrid } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { inIframes, quantize, stepMove } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import type { MoveState } from '../../../src/experiments/out-west/ffa/sim/types.ts'

const grid = buildGrid()
const state = (x: number, z: number): MoveState => ({
  x,
  z,
  rollTicks: 0,
  rollCooldown: 0,
  rollDirX: 0,
  rollDirZ: 0,
})
const input = (moveX: number, moveZ: number, buttons = 0, prevButtons = 0) => ({
  moveX,
  moveZ,
  aim: 0,
  buttons,
  prevButtons,
  canMove: true,
})

describe('movement', () => {
  test('runs at 5.5 m/s on open ground', () => {
    const m = state(30, 64)
    for (let i = 0; i < TICK_HZ; i++) {
      stepMove(grid, m, input(127, 0))
    }
    expect(m.x - 30).toBeCloseTo(RUN_SPEED, 1)
  })

  test('a hacked stick magnitude is clamped (no speed hack)', () => {
    const honest = state(30, 64)
    const hacked = state(30, 64)
    stepMove(grid, honest, input(127, 127))
    stepMove(grid, hacked, input(127, 127))
    const step = Math.hypot(honest.x - 30, honest.z - 64)
    expect(step).toBeCloseTo(RUN_SPEED / TICK_HZ, 2)
    expect(hacked).toEqual(honest)
  })

  test('the dead zone ignores stick noise', () => {
    const m = state(30, 64)
    expect(stepMove(grid, m, input(10, -8))).toBe(false)
    expect(m.x).toBe(30)
  })

  test('walls stop you and you slide along them', () => {
    // Run east into the saloon's west wall (x = 47) at z = 40, pushing diagonally.
    const m = state(44, 40)
    for (let i = 0; i < 40; i++) {
      stepMove(grid, m, input(127, 40))
    }
    expect(m.x).toBeLessThanOrEqual(47 - 0.4 + 1e-6)
    expect(m.z).toBeGreaterThan(41)
  })

  test('no tunnelling through a 0.5 m wall at roll speed', () => {
    const m = state(45.5, 40)
    for (let i = 0; i < 10; i++) {
      stepMove(grid, m, input(127, 0, i === 0 ? BTN_ROLL : 0, i === 1 ? BTN_ROLL : 0))
    }
    expect(m.x).toBeLessThan(47)
  })

  test('positions are quantised to the codec grid', () => {
    const m = state(30, 64)
    stepMove(grid, m, input(90, 37))
    expect(m.x).toBe(quantize(m.x))
    expect(m.z).toBe(quantize(m.z))
  })

  test('roll: 4 m in 0.35 s, i-frames for 0.25 s, 2.5 s cooldown', () => {
    const m = state(20, 64)
    stepMove(grid, m, input(127, 0, BTN_ROLL, 0))
    let iframeTicks = inIframes(m) ? 1 : 0
    let ticks = 1
    while (m.rollTicks > 0) {
      stepMove(grid, m, input(0, 0, BTN_ROLL, BTN_ROLL))
      iframeTicks += inIframes(m) ? 1 : 0
      ticks++
    }
    expect(ticks).toBe(7)
    expect(iframeTicks).toBe(5)
    expect(m.x - 20).toBeCloseTo(ROLL_DISTANCE, 1)
    // Can't roll again until the cooldown ends.
    const x = m.x
    stepMove(grid, m, input(0, 0, BTN_ROLL, 0))
    expect(m.x).toBe(x)
    for (let i = 0; i < ROLL_COOLDOWN_TICKS; i++) {
      stepMove(grid, m, input(0, 0))
    }
    stepMove(grid, m, input(0, 0, BTN_ROLL, 0))
    expect(m.rollTicks).toBeGreaterThan(0)
  })

  test('roll without a stick goes where you aim', () => {
    const m = state(20, 64)
    stepMove(grid, m, { ...input(0, 0, BTN_ROLL, 0), aim: 16_384 })
    expect(m.rollDirZ).toBeCloseTo(1, 5)
  })
})
