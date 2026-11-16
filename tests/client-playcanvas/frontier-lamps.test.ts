import { expect, test as it, spyOn } from 'bun:test'
import {
  ADDRESS_CLAMP_TO_EDGE,
  AppBase,
  AppOptions,
  Asset,
  BatchManager,
  BoundingBox,
  BoundingSphere,
  type ContainerResource,
  Entity,
  FILTER_LINEAR,
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
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import lighting from '../../src/experiments/out-west/content/lighting.json' with { type: 'json' }

function fixture({ pending = false, frontier = true } = {}) {
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
  const mask = new Texture(device, {
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
  const lanterns = Array.from({ length: 11 }, (_, i) => {
    const parent = new Entity(`authored-parent:${i}`, app)
    root.addChild(parent)
    parent.setLocalPosition(i * 2, 3, 1)
    parent.setLocalEulerAngles(0, i * 17, 0)
    parent.setLocalScale(0.275, 0.32, 0.2)
    const node = new Entity('lantern_hanging', app)
    parent.addChild(node)
    node.setLocalEulerAngles(7, 0, 4)
    node.addComponent('render', { type: 'box', material: source })
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
  let resolveMask!: (asset: Asset) => void
  let rejectMask!: (error: Error) => void
  const maskLoad = new Promise<Asset>((resolve, reject) => {
    resolveMask = resolve
    rejectMask = reject
  })
  const loads: { url: string; options: unknown }[] = []
  const game = {
    app,
    camera,
    environment: async () => undefined,
    loadTexture: (url: string, textureOptions: unknown) => {
      loads.push({ url, options: textureOptions })
      if (url === AMBIENT_ASSETS['lantern-glow'].url) {
        return pending ? maskLoad : Promise.resolve(textureAsset(mask))
      }
      return Promise.resolve(textureAsset(cloud))
    },
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
    environment = new NativeEnvironment(game, frontier)
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
    mask,
    loads,
    environment,
    asset,
    fixtures,
    material,
    resolveMask: () => resolveMask(textureAsset(mask)),
    rejectMask,
    cleanup() {
      environment.destroy()
      root.destroy()
      source.destroy()
      mask.destroy()
      cloud.destroy()
      app.destroy()
      return { textures: device.textures.size, buffers: device.buffers.size }
    },
  }
}

it('actual attach shares only lantern clone and native batches preserve source PBR/coffin ownership', async () => {
  const f = fixture()
  try {
    await f.environment.ready
    const material = f.material()
    expect(f.fixtures()).toHaveLength(11)
    expect(new Set(f.lanterns.map((n) => n.render?.meshInstances[0]?.material)).size).toBe(1)
    expect(material).not.toBe(f.source)
    expect(f.coffin.render?.meshInstances[0]?.material).not.toBe(material)
    expect(f.source.emissiveMap).toBeNull()
    const coffinMaterial = f.coffin.render?.meshInstances[0]?.material
    if (!(coffinMaterial instanceof StandardMaterial)) {
      throw new Error('Missing coffin material')
    }
    expect(coffinMaterial.emissiveMap).toBeNull()
    for (const key of ['diffuseMap', 'normalMap', 'aoMap', 'metalnessMap', 'glossMap'] as const) {
      expect(material[key]).toBe(f.source[key])
    }
    expect(material.diffuse.equals(f.source.diffuse)).toBe(true)
    expect(material.metalness).toBe(f.source.metalness)
    expect(material.diffuseDetailMap).toBe(f.cloud)
    expect(material.diffuseDetailMapUv).toBe(1)
    expect(material.emissiveMap).toBe(f.mask)
    expect(material.emissiveMapUv).toBe(0)
    expect(material.emissiveMapChannel).toBe('r')
    expect(f.loads.find((row) => row.url === AMBIENT_ASSETS['lantern-glow'].url)?.options).toEqual({
      srgb: false,
      flipY: false,
      mipmaps: false,
    })
    expect([
      f.mask.addressU,
      f.mask.addressV,
      f.mask.minFilter,
      f.mask.magFilter,
      f.mask.anisotropy,
      f.mask.mipmaps,
    ]).toEqual([
      ADDRESS_CLAMP_TO_EDGE,
      ADDRESS_CLAMP_TO_EDGE,
      FILTER_LINEAR,
      FILTER_LINEAR,
      1,
      false,
    ])
    const batches = Reflect.get(f.app.batcher, 'getBatches').call(
      f.app.batcher,
      f.lanterns[0]?.render?.batchGroupId,
    ) as { origMeshInstances: { material: StandardMaterial }[] }[]
    expect(
      batches.some((batch) => batch.origMeshInstances.some((mi) => mi.material === material)),
    ).toBe(true)
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
      const expected = lantern
        .getWorldTransform()
        .transformPoint(new Vec3(0, -0.523_209_318_518_637_7, 0))
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
      const map = f.material().diffuseDetailMap
      f.app.fire('update', 0.25)
      expect(f.material().diffuseDetailMap).toBe(map)
      expect(f.material().diffuseDetailMapOffset.x).not.toBe(0)
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

for (const owner of ['root', 'environment'] as const) {
  it(`${owner} destruction during real async mask load cannot resurrect lamps/material updates`, async () => {
    const f = fixture({ pending: true })
    const ready = f.environment.ready
    const material = f.material()
    const update = spyOn(material, 'update')
    const nativeLights = f
      .fixtures()
      .flatMap((entity) => (entity.light ? [entity.light.light] : []))
    try {
      expect(material.emissiveMap).toBeNull()
      expect(material.emissiveIntensity).toBe(0)
      if (owner === 'root') {
        f.root.destroy()
      } else {
        f.environment.destroy()
      }
      const calls = update.mock.calls.length
      f.resolveMask()
      await ready
      expect(update.mock.calls.length).toBe(calls)
      const layer = f.app.scene.layers.getLayerById(LAYERID_WORLD)
      expect(nativeLights.filter((light) => layer?.hasLight(light))).toHaveLength(0)
      f.environment.destroy()
      f.environment.destroy()
    } finally {
      update.mockRestore()
      expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
    }
  })
}

it('changing the sky before the mask resolves retains complete environment readiness', async () => {
  const f = fixture({ pending: true })
  try {
    let settled = false
    const ready = f.environment.setTime(0.75)
    void ready.then(() => {
      settled = true
    })
    expect(f.environment.ready).toBe(ready)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    f.resolveMask()
    await ready
    expect(settled).toBe(true)
    expect(f.material().emissiveMap).toBe(f.mask)
    expect(f.material().emissiveIntensity).toBe(6)
  } finally {
    expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('failed async mask load rejects environment readiness and remains safe to destroy', async () => {
  const f = fixture({ pending: true })
  try {
    const result = f.environment.ready.catch((error: unknown) => error)
    f.rejectMask(new Error('mask failure'))
    expect(await result).toEqual(new Error('mask failure'))
    f.environment.destroy()
  } finally {
    expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('duel environment loads no Frontier mask and keeps source lantern/coffin treatment unchanged', async () => {
  const f = fixture({ frontier: false })
  try {
    await f.environment.ready
    expect(f.fixtures()).toHaveLength(0)
    expect(f.loads.some((row) => row.url === AMBIENT_ASSETS['lantern-glow'].url)).toBe(false)
    const coffinMaterial = f.coffin.render?.meshInstances[0]?.material
    if (!(coffinMaterial instanceof StandardMaterial)) {
      throw new Error('Missing coffin material')
    }
    expect(f.material()).toBe(coffinMaterial)
    expect(f.material().emissiveMap).toBeNull()
  } finally {
    expect(f.cleanup()).toEqual({ textures: 0, buffers: 0 })
  }
})
