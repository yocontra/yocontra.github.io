import { expect, test as it } from 'bun:test'
import { file } from 'bun'
import {
  AnimComponentSystem,
  AnimCurve,
  AnimData,
  AnimEvents,
  AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  type ContainerResource,
  type Entity,
  NullGraphicsDevice,
  RenderComponentSystem,
} from 'playcanvas'
import { maskedTrack } from '../../src/experiments/out-west/scene/native-track-mask.ts'

it('retains animation events and a curve targeting both selected and excluded bones', () => {
  const path = (bone: string) => ({
    entityPath: ['Armature', 'Root', bone],
    component: 'graph',
    propertyPath: ['localPosition'],
  })
  const selected = path('Hips')
  const shared = new AnimCurve([selected, path('Abdomen')], 0, 0, 1)
  const track = new AnimTrack(
    'Stride',
    1,
    [new AnimData(1, [0, 1])],
    [new AnimData(3, [0, 0, 0, 1, 2, 3])],
    [shared],
    new AnimEvents([{ time: 0.4, name: 'footstep', side: 'left' }]),
  )
  const result = maskedTrack(track, { 'Armature/Root/Hips': { children: false } })
  expect(result.curves[0]?.paths).toEqual([selected])
  expect(result.events).toEqual([{ time: 0.4, name: 'footstep', side: 'left' }])
  expect(shared.paths).toHaveLength(2)
  expect(result.inputs).toBe(track.inputs)
  expect(result.outputs).toBe(track.outputs)
})

it('native masked playback preserves every authored pose and shared keyframe buffer', async () => {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem, AnimComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  app.init(options)
  const asset = new Asset('authored movements', 'container', {
    url: 'moves.glb',
    contents: await file('public/experiments/out-west/3d/native-v2/baked/moves.glb').arrayBuffer(),
  })
  try {
    app.assets.add(asset)
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve())
      asset.once('error', reject)
      app.assets.load(asset)
    })
    const resource = asset.resource as ContainerResource
    const tracks = resource.animations.map((animation) => animation.resource as AnimTrack)
    const paths = tracks.flatMap((track) => track.curves.flatMap((curve) => curve.paths))
    const mask = (...bones: [string, boolean][]) =>
      Object.fromEntries(
        paths.flatMap((path) => {
          const bone = bones.find(([name]) => path.entityPath.at(-1) === name)
          return bone ? [[path.entityPath.join('/'), { children: bone[1] }]] : []
        }),
      )
    const masks = [
      mask(['Root', false], ['Hips', false], ['UpperLegL', true], ['UpperLegR', true]),
      mask(['Abdomen', true]),
      mask(['Abdomen', false], ['Torso', false], ['Chest', false]),
    ]
    for (const selected of masks) {
      const create = (filtered: boolean) => {
        const root = resource.instantiateRenderEntity()
        app.root.addChild(root)
        root.addComponent('anim', { activate: false })
        const anim = root.anim
        if (!anim) {
          throw new Error('Missing native animation component')
        }
        anim.loadStateGraph({
          layers: [
            {
              name: 'Pose',
              states: [{ name: 'START' }, ...tracks.map((track) => ({ name: track.name }))],
              transitions: [],
            },
          ],
          parameters: {},
        })
        const layer = anim.baseLayer
        if (!layer) {
          throw new Error('Missing native animation layer')
        }
        layer.mask = selected
        for (const track of tracks) {
          layer.assignAnimation(track.name, filtered ? maskedTrack(track, selected) : track)
        }
        anim.activate = true
        anim.playing = true
        layer.play('Idle')
        return { root, anim, layer }
      }
      const reference = create(false)
      const candidate = create(true)
      const transforms = (root: Entity) =>
        root.find(() => true).map((node) => Array.from(node.getLocalTransform().data))
      const rest = JSON.stringify(transforms(reference.root))
      let removed = 0
      let moving = 0
      for (const track of tracks) {
        const trimmed = maskedTrack(track, selected)
        expect(trimmed.inputs).toBe(track.inputs)
        expect(trimmed.outputs).toBe(track.outputs)
        expect(trimmed.duration).toBe(track.duration)
        expect(trimmed.events).toEqual(track.events)
        expect(maskedTrack(track, { ...selected })).toBe(trimmed)
        removed += track.curves.length - trimmed.curves.length
        reference.layer.transition(track.name, 0.1)
        candidate.layer.transition(track.name, 0.1)
        for (const dt of [0, 0.04, 0.08, track.duration * 0.37]) {
          reference.anim.update(dt)
          candidate.anim.update(dt)
          expect(transforms(candidate.root)).toEqual(transforms(reference.root))
          if (JSON.stringify(transforms(reference.root)) !== rest) {
            moving++
          }
        }
      }
      expect(removed).toBeGreaterThan(tracks.length * 20)
      expect(moving).toBeGreaterThan(tracks.length)
      reference.root.destroy()
      candidate.root.destroy()
    }
  } finally {
    app.root.destroy()
    asset.unload()
    app.destroy()
  }
})
