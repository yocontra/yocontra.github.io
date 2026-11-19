import { expect, test as it } from 'bun:test'
import {
  AppBase,
  AppOptions,
  type ContainerResource,
  Entity,
  NullGraphicsDevice,
  RenderComponentSystem,
  StandardMaterial,
  Texture,
  Vec3,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { FrontierItems } from '../../src/experiments/out-west/client/items.ts'
import { DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'

function fixture(failTexture = false, closed = false) {
  const device = new NullGraphicsDevice()
  const app = new AppBase(device.canvas)
  const setup = new AppOptions()
  setup.graphicsDevice = device
  setup.componentSystems = [RenderComponentSystem]
  app.init(setup)
  const stage = new Entity('stage', app)
  if (!closed) {
    app.root.addChild(stage)
  }
  const textures = new Map<string, Texture>()
  const materials: StandardMaterial[] = []
  const loaded: string[] = []
  const released: string[] = []
  const game = {
    app,
    stage,
    loadContainer: (url: string) => {
      loaded.push(url)
      const material = new StandardMaterial()
      materials.push(material)
      const source = { albedo: 'albedo', arm: 'arm', ao: true }
      if (failTexture && url === DYNAMIC_ASSETS.strongbox.url) {
        source.albedo = 'failed-albedo'
      }
      const resource = {
        instantiateRenderEntity: () => new Entity('item', app),
        materials: [{ resource: material }],
        data: { gltf: { materials: [{ extras: { nativePbr: source } }] } },
      } as unknown as ContainerResource
      return Promise.resolve({ resource })
    },
    releaseContainer: (url: string) => released.push(url),
    loadTexture: (url: string) => {
      if (url === 'failed-albedo') {
        return Promise.reject(new Error('Injected KTX failure'))
      }
      let texture = textures.get(url)
      if (!texture) {
        texture = new Texture(device, { name: url, width: 1, height: 1 })
        textures.set(url, texture)
      }
      return Promise.resolve({ resource: texture })
    },
    releaseTexture: (url: string) => {
      textures.get(url)?.destroy()
      textures.delete(url)
    },
  } as unknown as GameApplication
  const dispose = () => {
    for (const material of materials) {
      material.destroy()
    }
    app.destroy()
  }
  return { game, stage, textures, loaded, released, dispose }
}

it('pickups own one material lease per container and retire it exactly once', async () => {
  const f = fixture()
  const items = await FrontierItems.create(f.game)
  expect(f.textures.size).toBe(2)
  expect(f.loaded.length).toBe(8)
  items.destroy()
  items.destroy()
  expect(f.textures.size).toBe(0)
  expect(f.released.toSorted((left, right) => left.localeCompare(right))).toEqual(
    f.loaded.toSorted((left, right) => left.localeCompare(right)),
  )
  f.dispose()
})

it('a failed material load releases its already-loaded container and all other pickup leases', async () => {
  const f = fixture(true)
  await expect(FrontierItems.create(f.game)).rejects.toThrow('Injected KTX failure')
  // All concurrently requested keys must finish their own failure/cancellation cleanup.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(f.textures.size).toBe(0)
  expect(f.released.toSorted((left, right) => left.localeCompare(right))).toEqual(
    f.loaded.toSorted((left, right) => left.localeCompare(right)),
  )
  expect(new Set(f.released).size).toBe(8)
  f.dispose()
})

it('a closed native stage cannot receive a late successful pickup loader', async () => {
  const f = fixture(false, true)
  await expect(FrontierItems.create(f.game)).rejects.toThrow('Pickups were closed')
  expect(f.textures.size).toBe(0)
  expect(f.released.length).toBe(8)
  f.dispose()
})

it('replaces same-tick pickups and retires old throws when Frontier reconnects', async () => {
  const { game, stage, dispose } = fixture()
  const items = await FrontierItems.create(game)
  const old = createWorld()
  const next = createWorld()
  const drop = {
    id: 1,
    x: 22,
    z: 31,
    amount: 5,
    exclusiveFor: 0,
    exclusiveUntil: 0,
    expiresAt: 90,
    style: 0,
  }
  old.bags.push(drop)
  next.bags.push({ ...drop, x: 62, z: 18 })
  try {
    items.update(old)
    const bag = stage.findByName('bag:1')
    expect(bag?.getPosition().x).toBe(22)
    items.update(next)
    expect(bag?.parent).toBeNull()
    expect(stage.findByName('bag:1')?.getPosition().x).toBe(62)

    items.update(old)
    const event = { type: 'dynamite_thrown', player: 0, x: 13, z: 16, fuseTicks: 50 } as const
    items.throwDynamite(event, new Vec3(2, 3, 4), { hand: () => null, world: old })
    const oldThrow = stage.findByName('item')
    expect(oldThrow?.parent).toBe(stage)

    items.throwDynamite(event, new Vec3(20, 30, 40), { hand: () => null, world: next })
    items.update(next)
    expect(oldThrow?.parent).toBeNull()
    expect(stage.findByName('bag:1')?.getPosition().x).toBe(62)
    expect(stage.findByName('item')?.getPosition().x).toBe(20)
  } finally {
    items.destroy()
    dispose()
  }
})
