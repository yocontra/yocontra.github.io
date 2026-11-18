import { expect, test as it, spyOn } from 'bun:test'
import {
  AppBase,
  AppOptions,
  Asset,
  BatchManager,
  BoundingBox,
  BoundingSphere,
  type ContainerResource,
  Entity,
  LAYERID_WORLD,
  LIGHTFALLOFF_INVERSESQUARED,
  LightComponentSystem,
  NullGraphicsDevice,
  PIXELFORMAT_RGBA8,
  RenderComponentSystem,
  StandardMaterial,
  Texture,
  Vec3,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { NativeClockwork } from '../../src/experiments/out-west/client/clockwork.ts'
import { NativeEnvironment } from '../../src/experiments/out-west/client/environment.ts'
import { NativeWilds } from '../../src/experiments/out-west/client/wilds.ts'
import lighting from '../../src/experiments/out-west/content/lighting.json' with { type: 'json' }

function fixture() {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem, LightComponentSystem]
  options.batchManager = BatchManager
  app.init(options)
  const root = new Entity('town', app)
  app.root.addChild(root)
  const camera = new Entity('camera', app)
  app.root.addChild(camera)
  const cloud = new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 })
  const glow = new Texture(device, {
    width: 1,
    height: 1,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
  })
  const source = new StandardMaterial()
  source.name = 'HalloweenBits'
  source.diffuse.set(0.4, 0.5, 0.6)
  source.diffuseMap = cloud
  source.normalMap = cloud
  source.aoMap = cloud
  source.metalnessMap = cloud
  source.glossMap = cloud
  source.useMetalness = true
  source.metalness = 0.3
  source.update()
  const glass = new StandardMaterial()
  glass.name = 'LampGlass'
  glass.emissiveMap = glow
  glass.update()
  const lanterns = Array.from({ length: 11 }, (_, i) => {
    const parent = new Entity(`authored-parent:${i}`, app)
    root.addChild(parent)
    parent.setLocalPosition(i * 2, 3, 1)
    parent.setLocalEulerAngles(0, i * 17, 0)
    parent.setLocalScale(0.275, 0.32, 0.2)
    const node = new Entity('frontier-lantern-glass', app)
    parent.addChild(node)
    node.setLocalEulerAngles(7, 0, 4)
    node.addComponent('render', { type: 'box', material: glass })
    return node
  })
  const coffin = new Entity('coffin', app)
  root.addChild(coffin)
  coffin.addComponent('render', { type: 'box', material: source })
  const asset = new Asset('town', 'container')
  asset.resource = {
    animations: [],
    materials: [],
    data: { gltf: { materials: [] } },
  } as unknown as ContainerResource
  const textureAsset = (texture: Texture) => {
    const result = new Asset('texture', 'texture')
    result.resource = texture
    return result
  }
  const game = {
    app,
    camera,
    environment: async () => undefined,
    loadTexture: () => Promise.resolve(textureAsset(cloud)),
  } as unknown as GameApplication
  const wilds = spyOn(NativeWilds, 'create').mockResolvedValue({
    destroy: () => undefined,
  } as NativeWilds)
  const clockwork = spyOn(NativeClockwork, 'create').mockResolvedValue({
    destroy: () => undefined,
    visible: () => undefined,
  } as unknown as NativeClockwork)
  let environment: NativeEnvironment
  try {
    environment = new NativeEnvironment(game, true)
  } finally {
    wilds.mockRestore()
    clockwork.mockRestore()
  }
  environment.attach(root, asset)
  const fixtures = () =>
    lanterns.flatMap((node) =>
      node.children.filter((child) => child.name === 'frontier-lantern-light'),
    ) as Entity[]
  const material = () => lanterns[0]?.render?.meshInstances[0]?.material as StandardMaterial
  return {
    app,
    device,
    root,
    source,
    lanterns,
    coffin,
    cloud,
    glass,
    glow,
    environment,
    asset,
    fixtures,
    material,
    cleanup() {
      environment.destroy()
      root.destroy()
      glass.destroy()
      source.destroy()
      glow.destroy()
      cloud.destroy()
      app.destroy()
      return { textures: device.textures.size, buffers: device.buffers.size }
    },
  }
}

it('grades the dedicated glass without changing the coffin atlas or recreating lights', async () => {
  const f = fixture()
  try {
    await f.environment.ready
    expect(f.fixtures()).toHaveLength(11)
    expect(new Set(f.lanterns.map((node) => node.render?.meshInstances[0]?.material)).size).toBe(1)
    expect(f.material()).not.toBe(f.glass)
    expect(f.material().emissiveMap).toBe(f.glow)
    const coffin = f.coffin.render?.meshInstances[0]?.material as StandardMaterial
    expect(coffin.diffuseMap).toBe(f.source.diffuseMap)
    expect(coffin.normalMap).toBe(f.source.normalMap)
    expect(coffin.emissiveMap).toBeNull()
    f.environment.attach(f.root, f.asset)
    expect(f.fixtures()).toHaveLength(11)
  } finally {
    expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('native omni world radius/AABB ignores nonuniform parent scale and uses actual transformed lens', async () => {
  const f = fixture()
  try {
    await f.environment.ready
    await f.environment.setTime(0.75)
    for (const [i, entity] of f.fixtures().entries()) {
      const lantern = f.lanterns[i]
      const light = entity.light?.light
      if (!(lantern && light)) {
        throw new Error('Missing actual native fixture')
      }
      const expected = lantern.getWorldTransform().transformPoint(new Vec3())
      const sphere = new BoundingSphere()
      const box = new BoundingBox()
      light.getBoundingSphere(sphere)
      light.getBoundingBox(box)
      expect(entity.getPosition().distance(expected)).toBeLessThan(1e-6)
      expect(sphere.center.distance(expected)).toBeLessThan(1e-6)
      expect(box.center.distance(expected)).toBeLessThan(1e-6)
      expect(sphere.radius).toBe(9)
      expect(box.halfExtents.toArray()).toEqual([9, 9, 9])
      expect(entity.light?.castShadows).toBe(false)
      expect(entity.light?.falloffMode).toBe(LIGHTFALLOFF_INVERSESQUARED)
      expect(entity.light?.intensity).toBe(0.5)
    }
  } finally {
    expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
  }
})

for (const day of [0.25, 0.3, 0.75]) {
  it(`authored time ${day} drives emission and light visibility without changing time`, async () => {
    const f = fixture()
    try {
      await f.environment.ready
      await f.environment.setTime(day)
      const preset = lighting[Math.round(day * 20)]
      if (!preset) {
        throw new Error('Missing preset')
      }
      const value = preset.lanterns
      expect(f.material().emissiveIntensity).toBe(value * 6)
      for (const lamp of f.fixtures()) {
        expect(lamp.light?.enabled).toBe(value > 0)
        expect(lamp.light?.intensity).toBe(value * 0.5)
      }
      f.app.fire('update', 0.25)
      expect(f.material().diffuseDetailMap).toBeNull()
      expect(f.material().emissiveIntensity !== value * 6).toBe(value > 0)
    } finally {
      expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
    }
  })
}

it('remove/readd keeps original owned lamps and removes their native layer contribution while detached', async () => {
  const f = fixture()
  try {
    await f.environment.ready
    await f.environment.setTime(0.75)
    const lights = f.fixtures()
    const material = f.material()
    const layer = f.app.scene.layers.getLayerById(LAYERID_WORLD)
    if (!layer) {
      throw new Error('Missing world layer')
    }
    const nativeLights = lights.map((entity) => {
      const light = entity.light?.light
      if (!light) {
        throw new Error('Missing native light')
      }
      return light
    })
    expect(nativeLights.filter((light) => layer.hasLight(light))).toHaveLength(11)
    f.root.remove()
    expect(lights.every((light) => light.light?.enabled === false)).toBe(true)
    expect(nativeLights.filter((light) => layer.hasLight(light))).toHaveLength(0)
    f.app.root.addChild(f.root)
    expect(f.fixtures()).toEqual(lights)
    expect(f.material()).toBe(material)
    expect(nativeLights.filter((light) => layer.hasLight(light))).toHaveLength(11)
  } finally {
    expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
  }
})
