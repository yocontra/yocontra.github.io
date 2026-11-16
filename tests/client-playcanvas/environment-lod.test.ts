import { expect, test as it, spyOn } from 'bun:test'
import {
  AppBase,
  AppOptions,
  Asset,
  BatchManager,
  type ContainerResource,
  Entity,
  LAYERID_WORLD,
  NullGraphicsDevice,
  PIXELFORMAT_RGBA8,
  RenderComponentSystem,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { NativeEnvironment } from '../../src/experiments/out-west/client/environment.ts'
import { NativeWilds } from '../../src/experiments/out-west/client/wilds.ts'

async function fixture(distance: number, disabledNear = false) {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem]
  options.batchManager = BatchManager
  app.init(options)
  const root = new Entity('town', app)
  const camera = new Entity('camera', app)
  app.root.addChild(root)
  app.root.addChild(camera)
  camera.setPosition(distance, 0, 0)
  const group = new Entity('model-lod:10:2:fixture', app)
  const near = new Entity('lod-near:fixture', app)
  const far = new Entity('lod-far:fixture', app)
  root.addChild(group)
  group.addChild(near)
  group.addChild(far)
  near.addComponent('render', { type: 'box', enabled: !disabledNear })
  far.addComponent('render', { type: 'sphere' })
  const cloud = new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 })
  const textureAsset = new Asset('cloud', 'texture')
  textureAsset.resource = cloud
  const game = {
    app,
    camera,
    environment: async () => undefined,
    loadTexture: async () => textureAsset,
  } as unknown as GameApplication
  // Unrelated background asset loading is isolated; attach, LODs, components and batching are real.
  const wilds = spyOn(NativeWilds, 'create').mockResolvedValue({
    destroy: () => undefined,
  } as NativeWilds)
  let environment: NativeEnvironment
  try {
    environment = new NativeEnvironment(game, true)
    await environment.ready
  } finally {
    wilds.mockRestore()
  }
  const asset = new Asset('fixture', 'container')
  asset.resource = {
    animations: [],
    materials: [],
    data: { gltf: { materials: [] } },
  } as unknown as ContainerResource
  environment.attach(root, asset)
  const batchGroup = app.batcher?.getGroupByName('environment-detail')
  if (!(batchGroup && near.render && far.render)) {
    throw new Error('Missing actual native fixture')
  }
  const snapshot = () => {
    app.batcher?.updateAll()
    const members = (Reflect.get(batchGroup, '_obj') as { render: Entity[] }).render
    const batches = Reflect.get(app.batcher, 'getBatches').call(app.batcher, batchGroup.id) as {
      origMeshInstances: { node: Entity }[]
    }[]
    return {
      members: members.map((node) => node.name).sort((a, b) => a.localeCompare(b, 'en')),
      sources: batches
        .flatMap((batch) => batch.origMeshInstances.map((mi) => mi.node.name))
        .sort((a, b) => a.localeCompare(b, 'en')),
      drawn: app.scene.layers
        .getLayerById(LAYERID_WORLD)
        ?.meshInstances.map((mi) => mi.mesh?.primitive[0]?.count),
    }
  }
  return {
    near,
    far,
    snapshot,
    move(value: number) {
      camera.setPosition(value, 0, 0)
      app.fire('update', 0)
    },
    destroy() {
      environment.destroy()
      root.destroy()
      cloud.destroy()
      app.destroy()
      return { buffers: device.buffers.size, textures: device.textures.size }
    },
  }
}

for (const initial of [0, 13]) {
  it(`actual environment attach batches only the initial ${initial === 0 ? 'near' : 'far'} tier`, async () => {
    const f = await fixture(initial)
    try {
      const expected = initial === 0 ? f.near : f.far
      const state = f.snapshot()
      expect(state.members).toEqual([expected.name])
      expect(state.sources).toEqual([expected.name])
      expect(state.drawn).toEqual([expected.render?.meshInstances[0]?.mesh?.primitive[0]?.count])
      for (const [distance, tier] of [
        [13, 'far'],
        [11, 'far'],
        [7, 'near'],
        [9, 'near'],
        [13, 'far'],
      ] as const) {
        f.move(distance)
        const active = tier === 'near' ? f.near : f.far
        expect([f.near.render?.enabled, f.far.render?.enabled]).toEqual([
          tier === 'near',
          tier === 'far',
        ])
        const current = f.snapshot()
        expect(current.members).toEqual([active.name])
        expect(current.sources).toEqual([active.name])
        expect(current.drawn).toEqual([active.render?.meshInstances[0]?.mesh?.primitive[0]?.count])
      }
    } finally {
      expect(f.destroy()).toEqual({ buffers: 0, textures: 0 })
    }
  })
}

it('pre-disabled source components stay out of native batches through LOD changes', async () => {
  const f = await fixture(0, true)
  try {
    expect(f.near.render?.enabled).toBe(false)
    expect(f.snapshot()).toEqual({ members: [], sources: [], drawn: [] })
    f.move(13)
    expect(f.snapshot().sources).toEqual([f.far.name])
    f.move(7)
    expect(f.snapshot()).toEqual({ members: [], sources: [], drawn: [] })
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0 })
  }
})
