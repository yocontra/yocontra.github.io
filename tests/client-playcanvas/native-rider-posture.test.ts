import { expect, test as it } from 'bun:test'
import {
  AnimCurve,
  AnimData,
  AnimEvents,
  AnimSnapshot,
  AnimTrack,
  INTERPOLATION_LINEAR,
  Quat,
  Vec3,
} from 'playcanvas'
import { visibleRiderPosture } from '../../src/experiments/out-west/scene/native-rider-posture.ts'

const neck = ['Root', 'Chest', 'Neck']
const position = {
  entityPath: [...neck, 'Head'],
  component: 'graph',
  propertyPath: ['localPosition'],
}
const hand = { ...position, entityPath: ['Root', 'HandL'] }
const rotation = { entityPath: neck, component: 'graph', propertyPath: ['localRotation'] }

it('settles the visible skull while keeping the neck bone, head rotations and shared keys intact', () => {
  const keys = new AnimData(1, [0, 1])
  const head = new AnimData(3, [0, 0.082, 0, 0, 0.082, 0])
  const pitch = new Quat().setFromAxisAngle(Vec3.RIGHT, 17)
  const rotate = new AnimData(4, [
    pitch.x,
    pitch.y,
    pitch.z,
    pitch.w,
    pitch.x,
    pitch.y,
    pitch.z,
    pitch.w,
  ])
  const common = new AnimCurve([position, hand], 0, 0, INTERPOLATION_LINEAR)
  const neckRotation = new AnimCurve([rotation], 0, 1, INTERPOLATION_LINEAR)
  const headRotation = new AnimCurve(
    [{ ...rotation, entityPath: position.entityPath }],
    0,
    1,
    INTERPOLATION_LINEAR,
  )
  const events = new AnimEvents([{ name: 'recoil', time: 0.125 }])
  const track = new AnimTrack(
    'Gun_Shoot',
    1,
    [keys],
    [head, rotate],
    [common, neckRotation, headRotation],
    events,
  )

  const fitted = visibleRiderPosture(track)
  expect(visibleRiderPosture(track)).toBe(fitted)
  expect(fitted.events).toEqual(track.events)
  expect(fitted.duration).toBe(track.duration)
  expect(track.curves[0]).toBe(common)
  expect(track.outputs[0]).toBe(head)
  expect(fitted.curves.map((curve) => curve.paths)).toEqual([
    [hand],
    [rotation],
    headRotation.paths,
    [position],
  ])
  expect(fitted.curves[1]).toBe(neckRotation)
  expect(fitted.curves[2]).toBe(headRotation)

  const snapshot = new AnimSnapshot(fitted)
  fitted.eval(0.43, snapshot)
  const original = pitch.transformVector(new Vec3(0, 0.082, 0))
  const [x = 0, y = 0, z = 0] = snapshot._results[3] ?? []
  const settled = pitch.transformVector(new Vec3(x, y, z))
  expect(original.z - settled.z).toBeGreaterThan(0.02)
  expect(settled.length()).toBeCloseTo(original.length(), 6)
  expect(snapshot._results[0]).toEqual([0, 0.082, 0])

  const crouch = new AnimTrack(
    'Crouch_Gun_Shoot',
    1,
    [keys],
    [head, rotate],
    [common, neckRotation],
  )
  expect(visibleRiderPosture(crouch)).toBe(crouch)
})
