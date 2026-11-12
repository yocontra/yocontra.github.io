import { expect, test as it } from 'bun:test'
import { gait } from '../../src/experiments/out-west/client/actor-animation.ts'
import {
  ADS_SPEED_FACTOR,
  CROUCH_SPEED,
  ROLL_SPEED,
  RUN_SPEED,
  SLIDE_SPEED,
  SPRINT_SPEED,
} from '../../src/experiments/out-west/ffa/sim/constants.ts'
import { makeMoveState } from '../../src/experiments/out-west/ffa/sim/types.ts'
import type { PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'

const pose = (extra: Partial<PlayerState> = {}): PlayerState => ({
  id: 'p',
  x: 0,
  y: 0.9,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  pitch: 0,
  grounded: true,
  crouched: false,
  hp: 100,
  ammo: 6,
  seq: 0,
  ...extra,
})

it('slides and rolls hold a low pose instead of pedalling a crouch walk at 4-8x', () => {
  const sliding = { ...makeMoveState(0, 0), slideTicks: 6 }
  const rolling = { ...makeMoveState(0, 0), rollTicks: 3 }
  expect(gait(pose({ crouched: true, motion: sliding }), undefined, SLIDE_SPEED)).toBe(
    'Crouch_Idle',
  )
  expect(gait(pose({ motion: rolling }), undefined, ROLL_SPEED)).toBe('Crouch_Idle')
  expect(gait(pose({ crouched: true }), undefined, SLIDE_SPEED * 0.6)).toBe('Crouch_Idle')
  expect(gait(pose(), undefined, ROLL_SPEED)).toBe('Crouch_Idle')
})

it('every steady movement speed picks the stride nearest its authored cadence', () => {
  expect(gait(pose({ crouched: true }), undefined, CROUCH_SPEED)).toBe('Crouch_Walk')
  expect(gait(pose(), undefined, RUN_SPEED * ADS_SPEED_FACTOR)).toBe('Run')
  expect(gait(pose(), undefined, 1.8)).toBe('Walk')
  expect(gait(pose(), undefined, RUN_SPEED)).toBe('Run')
  expect(gait(pose(), undefined, SPRINT_SPEED)).toBe('Sprint')
  expect(gait(pose(), undefined, 0)).toBe('Idle')
})
