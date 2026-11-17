import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  AppBase,
  AppOptions,
  type ContainerResource,
  Entity,
  NullGraphicsDevice,
  RenderComponentSystem,
  StandardMaterial,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { itemById } from '../../src/experiments/out-west/data/catalog.ts'
import { DYES, isDyeable } from '../../src/experiments/out-west/data/dye.ts'
import { applyDye } from '../../src/experiments/out-west/scene/native-equipment.ts'
import { prepareNativeMaterials } from '../../src/experiments/out-west/scene/native-materials.ts'

interface MaterialJSON {
  name: string
  extras?: {
    nativePbr?: { albedo: string; normal?: string; arm?: string; dyes?: Record<string, string> }
  }
}
interface Source {
  materials: MaterialJSON[]
  meshes: { primitives: { material: number }[] }[]
}
async function source(id: keyof typeof EQUIPMENT): Promise<Source> {
  const bytes = await readFile(`public${EQUIPMENT[id].url.split('?')[0]}`)
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as Source
}
function referenced(doc: Source) {
  return [...new Set(doc.meshes.flatMap((mesh) => mesh.primitives.map((p) => p.material)))].map(
    (index) => doc.materials[index],
  )
}

it.each(['extra.red-bandana', 'extra.black-bandana'] as const)(
  '%s offers correspond to seven effective maps on actual rendered surfaces',
  async (id) => {
    const doc = await source(id)
    const supported = referenced(doc)
      .flatMap((material) => Object.entries(material?.extras?.nativePbr?.dyes ?? {}))
      .filter(([, url]) => typeof url === 'string' && url.length > 0)
    const item = itemById(id)
    if (!item) {
      throw new Error(`Missing ${id}`)
    }
    expect(isDyeable(item)).toBe(true)
    expect(supported.map(([dye]) => dye).sort()).toEqual(
      DYES.filter((dye) => dye.id !== 'natural')
        .map((dye) => dye.id)
        .sort(),
    )
    const maps = await Promise.all(supported.map(([, url]) => readFile(`public${url}`)))
    for (const map of maps) {
      expect(map.subarray(0, 12)).toEqual(
        Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    }
  },
)
it.each(['extra.handlebar', 'extra.tin-star'] as const)(
  '%s has no effective dye map and cannot sell a dye job',
  async (id) => {
    const doc = await source(id)
    const supported = referenced(doc)
      .flatMap((material) => Object.values(material?.extras?.nativePbr?.dyes ?? {}))
      .filter((url) => typeof url === 'string' && url.length > 0)
    const item = itemById(id)
    if (!item) {
      throw new Error(`Missing ${id}`)
    }
    expect(supported).toEqual([])
    expect(isDyeable(item)).toBe(false)
  },
)

async function fixture(id: keyof typeof EQUIPMENT) {
  const doc = await source(id)
  const device = new NullGraphicsDevice()
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem]
  app.init(options)
  const model = new Entity('equipment', app)
  app.root.addChild(model)
  const materials = doc.materials.map((m) => {
    const value = new StandardMaterial()
    value.name = m.name
    return value
  })
  for (const [index, material] of materials.entries()) {
    const child = new Entity(`surface-${index}`, app)
    model.addChild(child)
    child.addComponent('render', { type: 'box', material })
  }
  const maps = new Map<string, Texture>()
  const loaded: string[] = []
  const game = {
    app,
    stage: app.root,
    loadTexture: (url: string) => {
      loaded.push(url)
      const texture = new Texture(device, { name: url, width: 1, height: 1 })
      maps.set(url, texture)
      return Promise.resolve({ resource: texture })
    },
    releaseTexture: (url: string) => {
      maps.get(url)?.destroy()
      maps.delete(url)
    },
  } as unknown as GameApplication
  const release = await prepareNativeMaterials(game, {
    materials: materials.map((resource) => ({ resource })),
    data: { gltf: doc },
  } as unknown as ContainerResource)
  return {
    doc,
    device,
    app,
    model,
    materials,
    maps,
    loaded,
    game,
    dispose: () => {
      model.destroy()
      release()
      for (const material of materials) {
        material.destroy()
      }
      app.destroy()
    },
  }
}

it('outfit dye touches only Dyeable, preserving body neckerchief/skin despite their own maps', async () => {
  const f = await fixture('outfit.trail-duds')
  try {
    const before = f.model
      .findComponents('render')
      .map((render) => render.meshInstances[0]?.material)
    expect(f.materials.some((material) => material.name === 'Dyeable')).toBe(true)
    await applyDye(f.game, f.model, 'coal')
    for (const [index, render] of f.model.findComponents('render').entries()) {
      const current = render.meshInstances[0]?.material
      const original = before[index]
      if (!(original instanceof StandardMaterial)) {
        throw new Error('Missing source material')
      }
      expect(current === original).toBe(original.name !== 'Dyeable')
    }
  } finally {
    f.dispose()
  }
  expect(f.device.textures.size).toBe(0)
  expect(f.device.buffers.size).toBe(0)
})

for (const id of ['extra.red-bandana', 'extra.black-bandana'] as const) {
  it(`${id} applies the actual authored Neckerchief map through the attachment scope and cleans its clone`, async () => {
    const f = await fixture(id)
    try {
      const original = f.materials[0]
      const render = f.model.findComponents('render')[0]
      if (!(original && render)) {
        throw new Error('Missing actual attachment surface')
      }
      const base = original.diffuseMap
      const url = f.doc.materials[0]?.extras?.nativePbr?.dyes?.coal
      if (!url) {
        throw new Error('Missing effective authored coal map')
      }
      await applyDye(f.game, f.model, 'coal', 'attachment')
      const dyed = render.meshInstances[0]?.material
      expect(original.name).toBe('Neckerchief')
      expect(dyed).not.toBe(original)
      expect((dyed as StandardMaterial).diffuseMap?.name).toBe(url)
      expect(original.diffuseMap).toBe(base)
      expect((dyed as StandardMaterial).normalMap).toBe(original.normalMap)
      expect((dyed as StandardMaterial).glossMap).toBe(original.glossMap)
      expect(f.loaded).toContain(url)
      f.model.destroy()
      expect(f.maps.has(url)).toBe(false)
    } finally {
      f.dispose()
    }
    expect(f.device.textures.size).toBe(0)
    expect(f.device.buffers.size).toBe(0)
  })
}
