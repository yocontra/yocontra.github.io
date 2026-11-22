import { expect, test as it } from 'bun:test'
import { Vec3 } from 'playcanvas'
import { aimedTarget, controllerAimScale } from '../../src/experiments/out-west/client/targeting.ts'
import { createWorld, newPlayer } from '../../src/experiments/out-west/ffa/sim/state.ts'

function fixture() {
  const world = createWorld()
  for (const id of [0, 1]) {
    const player = newPlayer(id, {
      accountId: String(id),
      name: 'Rider',
      level: 1,
      prestige: 0,
      bot: false,
    })
    Object.assign(player, { x: 10 + id * 5, z: 10, y: 0, alive: true, hp: 100, protectUntil: 0 })
    world.players[id] = player
  }
  const input = { seq: 0, moveX: 0, moveZ: 0, yaw: -Math.PI / 2, pitch: 0, buttons: 0 }
  return { world, input, selfSlot: 0, cameraTrace: () => null }
}
it('native touch targeting uses the shared player capsule and rejects protected riders', () => {
  const session = fixture()
  expect(aimedTarget(session, session.input)).toBe(1)
  const target = session.world.players[1]
  if (target) {
    target.protectUntil = 100
  }
  expect(aimedTarget(session, session.input)).toBeNull()
})
it('native Ammo occlusion prevents auto fire through a solid wall', () => {
  const session = fixture()
  expect(
    aimedTarget({ ...session, cameraTrace: () => new Vec3(12, 1.5, 10) }, session.input),
  ).toBeNull()
})
it('touch targeting respects aim pitch and dead riders', () => {
  const session = fixture()
  expect(aimedTarget(session, { ...session.input, pitch: 1 })).toBeNull()
  const target = session.world.players[1]
  if (target) {
    target.alive = false
  }
  expect(aimedTarget(session, session.input)).toBeNull()
})

it('controller resistance applies only to an eligible visible rider', () => {
  const session = fixture()
  expect(controllerAimScale(session, session.input)).toBe(0.78)
  expect(controllerAimScale(session, { ...session.input, yaw: 0 })).toBe(1)
  expect(controllerAimScale({ ...session, cameraTrace: undefined }, session.input)).toBe(1)
  expect(
    controllerAimScale({ ...session, cameraTrace: () => new Vec3(12, 1.5, 10) }, session.input),
  ).toBe(1)
  const shooter = session.world.players[0]
  const target = session.world.players[1]
  if (!(shooter && target)) {
    throw new Error('Missing practice riders')
  }
  target.protectUntil = 100
  expect(controllerAimScale(session, session.input)).toBe(1)
  target.protectUntil = 0
  shooter.showdown = 1
  expect(controllerAimScale(session, session.input)).toBe(1)
})
