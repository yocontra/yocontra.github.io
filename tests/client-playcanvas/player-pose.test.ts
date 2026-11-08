import { expect, test as it } from 'bun:test'
import {
  ownPresentation,
  poseEye,
  RenderedVelocity,
  snapshotPresentation,
} from '../../src/experiments/out-west/client/player-pose.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'
import { neutralInput, type PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'

function body(): PlayerState {
  return {
    id: '0',
    x: 5,
    y: 0.9,
    z: 8,
    vx: 5.5,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    hp: 100,
    ammo: 6,
    seq: 7,
    motion: newMotion(5, 0, 8),
  }
}
it('grounded input release stops locomotion on the same rendered frame without mutating physics', () => {
  const predicted = body()
  const pose = ownPresentation(predicted, { ...neutralInput(), yaw: 1.2, pitch: 0.4 })
  expect([pose.vx, pose.vz, pose.yaw, pose.pitch]).toEqual([0, 0, 1.2, 0.4])
  expect([pose.x, pose.y, pose.z]).toEqual([5, 0.9, 8])
  expect(predicted.vx).toBe(5.5)
})
it('airborne and committed native traversal retain their actual motor velocity on release', () => {
  const airborne = { ...body(), grounded: false }
  expect(ownPresentation(airborne, neutralInput()).vx).toBe(5.5)
  const rolling = body()
  if (rolling.motion) {
    rolling.motion.rollTicks = 4
  }
  expect(ownPresentation(rolling, neutralInput()).vx).toBe(5.5)
})
it('local predicted motor and current aim take priority over a delayed authoritative echo', () => {
  const predicted = { ...body(), vx: 0, vz: 2, grounded: true }
  const authority = { ...body(), grounded: false, vx: -5, yaw: -1, pitch: -70, hp: 80, ammo: 3 }
  const pose = snapshotPresentation(
    authority,
    { x: 6, y: 1, z: 9 },
    {
      predicted,
      intent: { ...neutralInput(), moveZ: 1, yaw: 2, pitch: 0.3 },
      yaw: 2,
    },
  )
  expect([pose.vx, pose.vz, pose.grounded, pose.yaw, pose.pitch]).toEqual([0, 2, true, 2, 0.3])
  expect([pose.hp, pose.ammo]).toEqual([80, 3])
  expect([pose.x, pose.y, pose.z]).toEqual([6, 1, 9])
})
it('remote presentation preserves the SDK interpolated position and yaw without another spring', () => {
  const pose = snapshotPresentation(
    { ...body(), pitch: 0 },
    { x: 1.125, y: 0.9, z: 2.25 },
    {
      predicted: undefined,
      intent: undefined,
      yaw: 0.75,
    },
  )
  expect([pose.x, pose.z, pose.yaw, pose.vx]).toEqual([1.125, 2.25, 0.75, 5.5])
})

it('camera and cosmetic rays use effective motor stance and the standing-centre feet convention', () => {
  const authority = { ...body(), crouched: false }
  const predicted = { ...body(), crouched: true }
  const pose = snapshotPresentation(authority, predicted, {
    predicted,
    intent: neutralInput(),
    yaw: 0,
  })
  expect(pose.crouched).toBe(true)
  expect(poseEye(pose)).toEqual({ x: 5, y: 1.02, z: 8 })
  expect(poseEye(authority).y).toBeCloseTo(1.62)
  expect(poseEye({ ...pose, y: 2.9 }).y).toBeCloseTo(3.02)
  expect(ownPresentation(predicted, neutralInput()).crouched).toBe(true)
})

it('observed remote animation tracks displayed stop, strafe, crouch and air instead of newest server velocity', () => {
  const motion = new RenderedVelocity()
  const start = body()
  motion.sample(start, 10, 1000)
  const strafe = motion.sample({ ...start, x: 5.1, z: 8.2, vx: 0, vz: 0 }, 10, 1050)
  expect(strafe.vx).toBeCloseTo(2)
  expect(strafe.vz).toBeCloseTo(4)
  const stop = motion.sample({ ...strafe, vx: 5.5, vz: 3 }, 10, 1100)
  expect([stop.vx, stop.vz]).toEqual([0, 0])
  const air = motion.sample({ ...stop, y: 1.1, grounded: true }, 10, 1150)
  expect(air.grounded).toBe(false)
  expect(air.vy).toBeCloseTo(4)
  const crouch = motion.sample({ ...air, x: 5.15, y: 1.1 }, 10, 1200)
  expect(crouch.vx).toBeCloseTo(1)
})
it('teleports and new incarnations never become enormous fake locomotion speeds', () => {
  const motion = new RenderedVelocity()
  motion.sample(body(), 10, 1000)
  const teleported = { ...body(), x: 90, vx: 0, vz: 0 }
  expect(motion.sample(teleported, 10, 1050).vx).toBe(0)
  expect(motion.sample({ ...teleported, x: 4 }, 20, 1100).vx).toBe(0)
  motion.retain(new Map())
  expect(motion.sample({ ...teleported, x: 0 }, 20, 1150).vx).toBe(0)
})
