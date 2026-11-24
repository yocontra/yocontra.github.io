import { expect, test as it } from 'bun:test'
import { Entity, Vec3 } from 'playcanvas'
import { FollowCamera } from '../../src/experiments/out-west/client/player-camera.ts'
import { poseEye } from '../../src/experiments/out-west/client/player-pose.ts'
import { DEFAULTS } from '../../src/experiments/out-west/ffa/client/settings.ts'
import type { PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'

const player: PlayerState = {
  id: 'rider',
  x: 0,
  y: 0.9,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  pitch: 0,
  grounded: true,
  hp: 100,
  ammo: 6,
  seq: 0,
}

function fixture() {
  const camera = new Entity('camera')
  const rig = new FollowCamera()
  const options = {
    camera,
    player,
    input: { yaw: 0, pitch: 0 },
    settings: DEFAULTS,
    first: false,
    recoil: 0,
    trace: undefined,
    dt: 1 / 60,
    reducedMotion: false,
  }
  return { camera, rig, options }
}

it('a corner obstruction pulls the camera in immediately and the clear view returns gradually', () => {
  const { camera, rig, options } = fixture()
  rig.place(options)
  expect(camera.getPosition().z).toBe(4.5)

  const trace = (from: Vec3, to: Vec3) =>
    to.x > 0.65 && to.y > 2 ? new Vec3().lerp(from, to, 0.4) : null
  rig.place({ ...options, trace })
  const blocked = camera.getPosition().z
  expect(blocked).toBeGreaterThan(0)
  expect(blocked).toBeLessThan(1.8)

  rig.place(options)
  expect(camera.getPosition().z).toBeGreaterThan(blocked)
  expect(camera.getPosition().z).toBeLessThan(blocked + 0.5)
  for (let frame = 0; frame < 65; frame++) {
    rig.place(options)
  }
  expect(camera.getPosition().z).toBe(4.5)
})

it('respawn, reduced motion and switching views discard the previous follow distance', () => {
  const { camera, rig, options } = fixture()
  const trace = (from: Vec3, to: Vec3) => new Vec3().lerp(from, to, 0.2)
  rig.place({ ...options, trace })
  rig.place({ ...options, player: { ...player, z: 7 } })
  expect(camera.getPosition().z).toBe(11.5)

  rig.place({ ...options, trace })
  rig.place({ ...options, reducedMotion: true })
  expect(camera.getPosition().z).toBe(4.5)

  rig.place({ ...options, trace })
  const eye = poseEye(player)
  const failTrace = () => {
    throw new Error('First-person and overhead placement should skip obstruction rays')
  }
  rig.place({ ...options, first: true, trace: failTrace })
  expect(camera.getPosition().distance(new Vec3(eye.x, eye.y, eye.z))).toBeLessThan(1e-5)
  rig.place(options)
  expect(camera.getPosition().z).toBe(4.5)

  rig.place({ ...options, trace })
  rig.place({ ...options, settings: { ...DEFAULTS, view: 'top' }, trace: failTrace })
  expect(camera.getPosition().distance(new Vec3(eye.x, eye.y + 30, eye.z + 0.01))).toBeLessThan(
    1e-5,
  )
  rig.place(options)
  expect(camera.getPosition().z).toBe(4.5)
})

it('a boardwalk edge changes lens height gradually while horizontal travel follows each frame', () => {
  const { camera, rig, options } = fixture()
  rig.place(options)
  const initial = camera.getPosition().y
  for (let frame = 1; frame <= 6; frame++) {
    rig.place({ ...options, player: { ...player, x: frame * 0.06, y: player.y + 0.18 } })
    expect(camera.getPosition().x).toBeCloseTo(frame * 0.06 + options.settings.shoulder * 0.6)
    const height = camera.getPosition().y - initial
    expect(height).toBeGreaterThan(0)
    expect(height).toBeLessThan(0.18)
  }
  rig.place({ ...options, player: { ...player, x: 10, y: player.y + 0.5 } })
  expect(camera.getPosition().y).toBeCloseTo(initial + 0.5)
})

it('a narrow gap between posts cannot kick the lens out for a single frame', () => {
  const { camera, rig, options } = fixture()
  const trace = (from: Vec3, to: Vec3) => new Vec3().lerp(from, to, 0.25)
  rig.place({ ...options, trace })
  const atPost = camera.getPosition().z
  rig.place(options)
  expect(camera.getPosition().z - atPost).toBeLessThan(0.07)
  rig.place({ ...options, trace })
  expect(camera.getPosition().z).toBeCloseTo(atPost)
})
