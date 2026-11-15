import { expect, test as it } from 'bun:test'
import {
  AppBase,
  AppOptions,
  BatchManager,
  Entity,
  LAYERID_WORLD,
  NullGraphicsDevice,
  RenderComponentSystem,
  Vec3,
} from 'playcanvas'
import { NativeModelLods } from '../../src/experiments/out-west/client/model-lod.ts'

function fixture(name = 'model-lod:28:4:fixture') {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem]
  options.batchManager = BatchManager
  app.init(options)
  const root = new Entity('town', app)
  app.root.addChild(root)
  const group = new Entity(name, app)
  root.addChild(group)
  const near = new Entity('lod-near:', app)
  const far = new Entity('lod-far:', app)
  group.addChild(near)
  group.addChild(far)
  near.addComponent('render', { type: 'box' })
  far.addComponent('render', { type: 'sphere' })
  if (!(near.render && far.render && app.batcher)) {
    throw new Error('Missing native fixture renderer')
  }
  const high = near.render
  const low = far.render
  const lod = new NativeModelLods(root)
  const batch = app.batcher.addGroup('details', false, 32)
  high.batchGroupId = batch.id
  low.batchGroupId = batch.id
  const drawn = () => {
    app.batcher?.updateAll()
    return app.scene.layers
      .getLayerById(LAYERID_WORLD)
      ?.meshInstances.map((instance) => instance.mesh?.primitive[0]?.count)
  }
  return { app, root, group, high, low, lod, drawn }
}
it('native LOD switches replace batches with one active variant and stable distance hysteresis', () => {
  const f = fixture()
  try {
    f.lod.update(new Vec3(0, 0, 0))
    expect([f.high.enabled, f.low.enabled]).toEqual([true, false])
    expect(f.drawn()).toEqual([f.high.meshInstances[0]?.mesh?.primitive[0]?.count])
    f.lod.update(new Vec3(31, 0, 0))
    expect(f.low.enabled).toBe(false)
    f.lod.update(new Vec3(33, 0, 0))
    expect([f.high.enabled, f.low.enabled]).toEqual([false, true])
    expect(f.drawn()).toEqual([f.low.meshInstances[0]?.mesh?.primitive[0]?.count])
    f.lod.update(new Vec3(25, 0, 0))
    expect(f.high.enabled).toBe(false)
    f.lod.update(new Vec3(23, 0, 0))
    expect(f.drawn()).toEqual([f.high.meshInstances[0]?.mesh?.primitive[0]?.count])
    expect(f.lod.owns(f.high)).toBe(true)
  } finally {
    f.lod.destroy()
    f.app.destroy()
  }
})
it('camera distance uses the group world transform including vertical separation', () => {
  const f = fixture()
  try {
    f.root.setPosition(100, 4, 0)
    f.group.setLocalPosition(5, 2, 0)
    f.lod.update(new Vec3(105, 6, 0))
    expect(f.high.enabled).toBe(true)
    f.lod.update(new Vec3(105, 40, 0))
    expect(f.low.enabled).toBe(true)
    f.root.enabled = false
    f.lod.update(new Vec3(105, 6, 0))
    expect(f.low.enabled).toBe(true)
    f.root.enabled = true
    f.lod.update(new Vec3(105, 6, 0))
    expect(f.high.enabled).toBe(true)
  } finally {
    f.lod.destroy()
    f.app.destroy()
  }
})
it('teardown drops all references and late updates cannot resurrect destroyed scene components', () => {
  const f = fixture()
  f.lod.update(new Vec3(40, 0, 0))
  f.lod.destroy()
  expect(f.lod.owns(f.high)).toBe(false)
  f.app.destroy()
  expect(() => f.lod.update(new Vec3())).not.toThrow()
})
