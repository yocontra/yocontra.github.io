import { expect, test as it } from 'bun:test'
import { type ContainerResource, NullGraphicsDevice, StandardMaterial, Texture } from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { prepareNativeMaterials } from '../../src/experiments/out-west/scene/native-materials.ts'

function fixture() {
  const device = new NullGraphicsDevice()
  const maps = new Map<string, Texture>()
  const releases: string[] = []
  const game = {
    loadTexture: (url: string) => {
      let texture = maps.get(url)
      if (!texture) {
        texture = new Texture(device, { name: url, width: 1, height: 1 })
        maps.set(url, texture)
      }
      return Promise.resolve({ resource: texture })
    },
    releaseTexture: (url: string) => {
      releases.push(url)
      maps.get(url)?.destroy()
      maps.delete(url)
    },
  } as unknown as GameApplication
  const container = (material: StandardMaterial, surface: object) =>
    ({
      materials: [{ resource: material }],
      data: { gltf: { materials: [{ extras: { nativePbr: surface } }] } },
    }) as unknown as ContainerResource
  return { device, maps, game, container, releases }
}

it('real AO requires explicit semantics and shares the existing ARM lease', async () => {
  const f = fixture()
  const a = new StandardMaterial()
  const b = new StandardMaterial()
  const surface = { albedo: 'albedo', arm: 'arm', ao: true, aoUv: 1, aoStrength: 0.62 }
  const first = await prepareNativeMaterials(f.game, f.container(a, surface))
  const second = await prepareNativeMaterials(f.game, f.container(b, surface))
  expect(a.aoMap).toBe(a.metalnessMap)
  expect(a.aoMap).toBe(b.aoMap)
  expect(a.aoMapChannel).toBe('r')
  expect(a.aoMapUv).toBe(1)
  expect(a.aoIntensity).toBe(0.62)
  expect(f.maps.size).toBe(2)
  first()
  first()
  expect(a.aoMap).toBeNull()
  expect(b.aoMap).toBe(f.maps.get('arm') ?? null)
  expect(f.releases).toEqual([])
  second()
  expect(b.aoMap).toBeNull()
  expect(f.maps.size).toBe(0)
  expect(f.releases.toSorted((left, right) => left.localeCompare(right))).toEqual(['albedo', 'arm'])
  a.destroy()
  b.destroy()
  f.device.destroy()
})

it('a character recolor mask in ARM.r never becomes ambient occlusion by default', async () => {
  const f = fixture()
  const material = new StandardMaterial()
  const release = await prepareNativeMaterials(
    f.game,
    f.container(material, { albedo: 'character', arm: 'recolor-mask' }),
  )
  expect(material.metalnessMap).toBe(f.maps.get('recolor-mask') ?? null)
  expect(material.aoMap).toBeNull()
  release()
  expect(f.maps.size).toBe(0)
  material.destroy()
  f.device.destroy()
})

it('an explicit glTF AO map retains its channel, UV, strength and container ownership', async () => {
  const f = fixture()
  const material = new StandardMaterial()
  const explicit = new Texture(f.device, { name: 'authored-AO', width: 1, height: 1 })
  material.aoMap = explicit
  material.aoMapChannel = 'g'
  material.aoMapUv = 1
  material.aoIntensity = 0.35
  const release = await prepareNativeMaterials(
    f.game,
    f.container(material, { albedo: 'albedo', arm: 'arm', ao: true, aoUv: 0, aoStrength: 1 }),
  )
  expect(material.aoMap).toBe(explicit)
  expect(material.aoMapChannel).toBe('g')
  expect(material.aoMapUv).toBe(1)
  expect(material.aoIntensity).toBe(0.35)
  release()
  expect(material.aoMap).toBe(explicit)
  expect(f.maps.size).toBe(0)
  material.destroy()
  explicit.destroy()
  f.device.destroy()
})
