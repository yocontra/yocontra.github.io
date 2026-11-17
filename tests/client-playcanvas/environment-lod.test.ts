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
import { BreakableWindows } from '../../src/experiments/out-west/client/windows.ts'

function addLod(app: AppBase, root: Entity, name: string, x: number) {
  const group = new Entity(`model-lod:10:2:${name}`, app)
  const near = new Entity(`lod-near:${name}`, app)
  const far = new Entity(`lod-far:${name}`, app)
  root.addChild(group)
  group.setLocalPosition(x, 0, 0)
  group.addChild(near)
  group.addChild(far)
  near.addComponent('render', { type: 'box' })
  far.addComponent('render', { type: 'sphere' })
  return { group, near, far }
}

async function fixture(
  distance: number,
  { disabledNear = false, disabledFar = false, multipleRegions = false, worldOffset = 0 } = {},
) {
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
  root.setLocalPosition(worldOffset, 0, 0)
  app.root.addChild(camera)
  camera.setPosition(distance, 0, 0)
  const group = new Entity('model-lod:10:2:fixture', app)
  const near = new Entity('lod-near:fixture', app)
  const far = new Entity('lod-far:fixture', app)
  root.addChild(group)
  group.addChild(near)
  group.addChild(far)
  near.addComponent('render', { type: 'box', enabled: !disabledNear })
  far.addComponent('render', { type: 'sphere', enabled: !disabledFar })
  const neighbours = multipleRegions
    ? [
        addLod(app, root, 'same-cell', 4),
        addLod(app, root, 'east', 64),
        addLod(app, root, 'west', -40),
      ]
    : []
  const ordinary = new Entity('wall-fixture', app)
  const pane = new Entity('glass-0', app)
  const distantPane = new Entity('glass-1', app)
  if (multipleRegions) {
    root.addChild(ordinary)
    root.addChild(pane)
    ordinary.addComponent('render', { type: 'box' })
    pane.addComponent('render', { type: 'box' })
    root.addChild(distantPane)
    distantPane.setLocalPosition(64, 0, 0)
    distantPane.addComponent('render', { type: 'box' })
  }
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
  const batchGroup = app.batcher?.getGroupById(far.render?.batchGroupId ?? -1)
  if (!(near.render && far.render)) {
    throw new Error('Missing actual native fixture')
  }
  const snapshot = () => {
    app.batcher?.updateAll()
    const members = batchGroup
      ? (Reflect.get(batchGroup, '_obj') as { render: Entity[] }).render
      : []
    const batches = Reflect.get(app.batcher, 'getBatches').call(
      app.batcher,
      batchGroup?.id ?? -1,
    ) as {
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
    app,
    root,
    environment,
    neighbours,
    ordinary,
    pane,
    distantPane,
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
  const f = await fixture(0, { disabledNear: true })
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

it('native detail regeneration stays in its owner region and retains other batches', async () => {
  const f = await fixture(0, { multipleRegions: true })
  const batcher = f.app.batcher
  if (!batcher) {
    throw new Error('Missing native batch manager')
  }
  const batches = (id: number) => Reflect.get(batcher, 'getBatches').call(batcher, id) as object[]
  const ids = f.neighbours.map(({ near, far }) => {
    expect(near.render?.batchGroupId).toBe(far.render?.batchGroupId)
    return far.render?.batchGroupId ?? -1
  })
  const local = f.far.render?.batchGroupId ?? -1
  const ordinary = f.ordinary.render?.batchGroupId ?? -1
  const pane = f.pane.render?.batchGroupId ?? -1
  try {
    expect(ids[0]).toBe(local)
    const retained = [ids[1], ids[2], ordinary, pane].map((id) => batches(id ?? -1)[0])
    expect(retained.every(Boolean)).toBe(true)
    const oldLocal = batches(local)[0]
    const regenerate = batcher.generate.bind(batcher)
    const regenerated: number[][] = []
    const generate = spyOn(batcher, 'generate').mockImplementation((groups) => {
      regenerated.push([...(groups ?? [])])
      regenerate(groups)
    })
    try {
      f.move(13)
      f.snapshot()
      expect(generate).toHaveBeenCalledTimes(1)
      expect(regenerated).toEqual([[local]])
      expect(f.near.render?.enabled).toBe(false)
      expect(f.far.render?.enabled).toBe(true)
      expect(batches(local)[0]).not.toBe(oldLocal)
      for (const [index, id] of [ids[1], ids[2], ordinary, pane].entries()) {
        expect(batches(id ?? -1)[0] === retained[index]).toBe(true)
      }
      expect(new Set([local, ids[1], ids[2], ordinary, pane]).size).toBe(5)
      expect(batcher.getGroupById(ids[2] ?? -1)?.name).toBe('environment-detail:-2:0')
      // Inside the hysteresis band there is no additional native regeneration.
      f.move(11)
      f.snapshot()
      expect(generate).toHaveBeenCalledTimes(1)
      // Vertical separation still participates in the unchanged LOD threshold.
      f.app.root.findByName('camera')?.setPosition(0, 13, 0)
      f.app.fire('update', 0)
      f.snapshot()
      expect(f.far.render?.enabled).toBe(true)
    } finally {
      generate.mockRestore()
    }
    f.root.destroy()
    for (const id of [local, ...ids, ordinary, pane]) {
      expect(batcher.getGroupById(id)).toBeNull()
    }
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0 })
  }
})

it('region ownership uses the authored root world transform rather than local coordinates', async () => {
  const f = await fixture(96, { worldOffset: 96 })
  try {
    const id = f.far.render?.batchGroupId ?? -1
    expect(f.app.batcher?.getGroupById(id)?.name).toBe('environment-detail:3:0')
    expect(f.near.render?.batchGroupId).toBe(id)
    expect(f.snapshot().sources).toEqual([f.near.name])
    f.move(109)
    expect(f.snapshot().sources).toEqual([f.far.name])
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0 })
  }
})

it('fully authored-disabled LODs allocate no empty detail batch group', async () => {
  const f = await fixture(0, { disabledNear: true, disabledFar: true })
  try {
    expect(f.app.batcher?.getGroupByName('environment-detail:0:0')).toBeNull()
    expect(f.app.batcher?.getGroupByName('environment-detail')).toBeNull()
    expect(f.near.render?.batchGroupId).toBe(-1)
    expect(f.far.render?.batchGroupId).toBe(-1)
    f.move(13)
    expect(f.snapshot()).toEqual({ members: [], sources: [], drawn: [] })
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0 })
  }
})

it('breaking and restoring a pane replaces only its own street batch', async () => {
  const f = await fixture(0, { multipleRegions: true })
  try {
    const batcher = f.app.batcher
    if (!(batcher && f.pane.render && f.distantPane.render)) {
      throw new Error('Missing native glass fixture')
    }
    const local = f.pane.render.batchGroupId
    const distant = f.distantPane.render.batchGroupId
    const batches = (id: number) => Reflect.get(batcher, 'getBatches').call(batcher, id) as object[]
    expect(local).not.toBe(distant)
    const original = batches(local)[0]
    const retained = batches(distant)[0]
    expect(original).toBeDefined()
    expect(retained).toBeDefined()

    const panes = new BreakableWindows(f.root)
    panes.update(Uint8Array.of(1, 0))
    batcher.updateAll()
    expect(batches(local)).toEqual([])
    expect(batches(distant)[0] === retained).toBe(true)

    panes.update(Uint8Array.of(0, 0))
    batcher.updateAll()
    expect(batches(local)).toHaveLength(1)
    expect(batches(local)[0] === original).toBe(false)
    expect(batches(distant)[0] === retained).toBe(true)
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0 })
  }
})
