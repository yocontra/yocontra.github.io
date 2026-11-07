import { expect, it } from 'bun:test'
import { Vector3 } from 'three'
import { place, run, testWorld } from '../api/src/town/test-helpers.ts'
import { BTN_JUMP } from '../src/experiments/out-west/contract/town.ts'
import {
  CORPSE_MAX_FALL,
  CORPSE_MAX_HORIZONTAL,
  limitCorpseVelocity,
} from '../src/experiments/out-west/ffa/scene/ragdoll-motion.ts'
import {
  DT,
  JUMP_APEX,
  ROLL_SPEED,
  SLIDE_SPEED,
  SPRINT_SPEED,
} from '../src/experiments/out-west/ffa/sim/constants.ts'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { CLIMB_TICKS, CLIMBS } from '../src/experiments/out-west/ffa/sim/roofwalks.ts'

it.each([SPRINT_SPEED, SLIDE_SPEED, ROLL_SPEED])(
  'retains valid horizontal speed %f independently of an actual 8 m authoritative fall',
  (speed) => {
    const world = testWorld()
    const player = place(world, 20, 64)
    Object.assign(player, { y: 8, support: 0, grounded: false, vy: 0, airPeakY: 8 })
    run(world, 12)
    expect(player.vy).toBeCloseTo(-10.8, 8)
    const velocity = new Vector3(speed / Math.SQRT2, player.vy, speed / Math.SQRT2)
    const original = velocity.clone()
    limitCorpseVelocity(velocity)
    expect(velocity.toArray()).toEqual(original.toArray())
    limitCorpseVelocity(velocity, true)
    expect(velocity.toArray()).toEqual(original.toArray())
  },
)

it('retains every discrete falling speed from the highest authored roof plus a jump', () => {
  const world = testWorld()
  const player = place(world, 20, 64)
  const height =
    Math.max(...TOWN.buildings.map((building) => building.height + (building.roof?.rise ?? 0))) +
    JUMP_APEX
  Object.assign(player, { y: height, support: 0, grounded: false, vy: 0, airPeakY: height })
  let samples = 0
  while (!player.grounded && samples < 100) {
    run(world, 1)
    const velocity = new Vector3(2, player.vy, 1)
    limitCorpseVelocity(velocity)
    expect(velocity.y).toBe(player.vy)
    expect(velocity.x).toBe(2)
    expect(velocity.z).toBe(1)
    samples++
  }
  expect(player.grounded).toBe(true)
  expect(samples).toBeGreaterThan(20)
})

it('bounds impossible motion without scaling valid axes or propagating nonfinite state', () => {
  const fast = new Vector3(1000, -1000, 0)
  limitCorpseVelocity(fast)
  expect(fast.toArray()).toEqual([CORPSE_MAX_HORIZONTAL, -CORPSE_MAX_FALL, 0])
  const impact = new Vector3(ROLL_SPEED + 2, -CORPSE_MAX_FALL - 2, 0)
  const before = impact.clone()
  limitCorpseVelocity(impact, true)
  expect(impact.toArray()).toEqual(before.toArray())
  const invalid = new Vector3(Number.NaN, -10, 1)
  limitCorpseVelocity(invalid, true)
  expect(invalid.toArray()).toEqual([0, 0, 0])
})

function deltaError(before: Vector3, after: { x: number; y: number; z: number }): number {
  const velocity = new Vector3(after.x, after.y, after.z).sub(before).divideScalar(DT)
  const original = velocity.clone()
  limitCorpseVelocity(velocity)
  return velocity.distanceTo(original)
}

it('retains each committed vault arc sample, including its final ground settlement', () => {
  const world = testWorld()
  const fence = TOWN.cover.find((cover) => cover.kind === 'fence')
  if (!fence) {
    throw new Error('Missing authored fence')
  }
  const player = place(world, fence.x + fence.w / 2, fence.z + fence.d + 1.2)
  run(world, 10, { [player.id]: () => ({ moveZ: -127 }) })
  let before = new Vector3(player.x, player.y, player.z)
  run(world, 1, { [player.id]: () => ({ moveZ: -127, buttons: BTN_JUMP }) })
  expect(player.vaultStep).toBeGreaterThan(0)
  expect(deltaError(before, player)).toBeLessThan(1e-8)
  while (player.jumpTicks > 0) {
    before = new Vector3(player.x, player.y, player.z)
    run(world, 1)
    expect(deltaError(before, player)).toBeLessThan(1e-8)
  }
  expect(player.grounded).toBe(true)
})

it('retains actual boxcar ladder ascent, descent and off-axis final landing steps', () => {
  const world = testWorld()
  const climb = CLIMBS.find((candidate) => !candidate.walk)
  if (!climb) {
    throw new Error('Missing authored boxcar ladder')
  }
  const player = place(world, climb.bottomX, climb.bottomZ)
  for (let trip = 0; trip < 2; trip++) {
    run(world, 1, { [player.id]: () => ({ buttons: BTN_JUMP }) })
    expect(player.climbTicks).toBeGreaterThan(0)
    for (let step = 0; step < CLIMB_TICKS; step++) {
      const before = new Vector3(player.x, player.y, player.z)
      run(world, 1)
      expect(deltaError(before, player)).toBeLessThan(1e-8)
    }
  }
  expect(player.y).toBe(0)
})
