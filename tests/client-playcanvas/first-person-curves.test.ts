import { expect, test as it } from 'bun:test'
import { AnimCurve, AnimData, AnimEvents, AnimTrack, Asset, INTERPOLATION_LINEAR } from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { loadViewmodelTracks } from '../../src/experiments/out-west/client/first-person-curves.ts'

it('borrows native clips and replaces only the targets supplied by the first-person GLB', async () => {
  const target = (bone: string) => ({
    entityPath: ['Root', bone],
    component: 'graph',
    propertyPath: ['localPosition'],
  })
  const shoulder = target('UpperArmR')
  const stock = target('Chest')
  const times = new AnimData(1, [0, 0.6])
  const original = new AnimData(3, [0, 0, 0, 0, 0, 0])
  const lifted = new AnimData(3, [0, -0.125, 0.065, 0, -0.125, 0.065])
  const events = new AnimEvents([{ name: 'recoil', time: 0.25 }])
  const shared = new AnimCurve([shoulder, stock], 0, 0, INTERPOLATION_LINEAR)
  const base = new AnimTrack('Shoot_rifle', 0.6, [times], [original], [shared], events)
  const idle = new AnimTrack('Idle', 1, [], [], [])
  const patch = new AnimCurve([shoulder], 0, 0, INTERPOLATION_LINEAR)
  const clip = new Asset('viewmodel-arm-curves/animation/0', 'animation')
  clip.resource = new AnimTrack('Shoot_rifle', 0.6, [times], [lifted], [patch])
  const game = {
    loadContainer: async () => ({ resource: { animations: [clip] } }),
  } as unknown as GameApplication
  const world = [base, idle]
  const [shot, resting] = await loadViewmodelTracks(game, world)

  expect(shot).toBeDefined()
  expect(resting).toBe(idle)
  expect(shot?.duration).toBe(base.duration)
  expect(shot?.events).toEqual(base.events)
  expect(shot?.curves.map((curve) => curve.paths)).toEqual([[stock], [shoulder]])
  expect(shot?.curves.map((curve) => shot.outputs[curve.output])).toEqual([original, lifted])
  expect(shot?.curves.map((curve) => curve.input)).toEqual([0, 1])
  expect(base.curves[0]).toBe(shared)
  expect(base.curves[0]?.paths).toEqual([shoulder, stock])
  expect((await loadViewmodelTracks(game, world))[0]).toBe(shot)

  clip.resource = new AnimTrack('Shoot_rifle', 0.5, [times], [lifted], [patch])
  await expect(loadViewmodelTracks(game, world)).rejects.toThrow('duration of Shoot_rifle')
})
