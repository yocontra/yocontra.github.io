import { expect, test as it } from 'bun:test'
import { type ContainerResource, NullGraphicsDevice, StandardMaterial, Texture } from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { FrontierItems } from '../../src/experiments/out-west/client/items.ts'
import { DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'

function fixture(failTexture = false, closed = false) {
  const device = new NullGraphicsDevice()
  const textures = new Map<string, Texture>()
  const materials: StandardMaterial[] = []
  const loaded: string[] = []
  const released: string[] = []
  const game = {
    stage: { parent: closed ? null : {} },
    loadContainer: (url: string) => {
      loaded.push(url)
      const material = new StandardMaterial()
      materials.push(material)
      const source = { albedo: 'albedo', arm: 'arm', ao: true }
      if (failTexture && url === DYNAMIC_ASSETS.strongbox.url) {
        source.albedo = 'failed-albedo'
      }
      const resource = {
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
    device.destroy()
  }
  return { game, textures, loaded, released, dispose }
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
