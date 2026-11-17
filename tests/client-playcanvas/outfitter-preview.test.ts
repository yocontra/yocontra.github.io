import { afterEach, expect, test as it, mock, spyOn } from 'bun:test'
import { Entity, NullGraphicsDevice, StandardMaterial, Texture } from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { BAG_STYLES } from '../../src/experiments/out-west/contract/town.ts'
import { CATALOG, DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { NativeDirector } from '../../src/experiments/out-west/duel/native-director.ts'
import {
  dressForHub,
  NativeOutfitter,
} from '../../src/experiments/out-west/duel/native-outfitter.ts'

const equipment = await import('../../src/experiments/out-west/scene/native-equipment.ts')

afterEach(() => mock.restore())
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function rider(name: string) {
  const root = new Entity(name)
  return {
    root,
    destroy: () => root.destroy(),
    face: (degrees: number) => root.setEulerAngles(0, degrees, 0),
  } as unknown as DuelActor
}

it('unchanged profile/non-character choices keep actor identity; dressing retains exact native root yaw', async () => {
  const first = rider('first')
  const next = rider('next')
  first.root.setEulerAngles(0, 123, 0)
  const rotation = first.root.getRotation().clone()
  const factory = spyOn(equipment, 'equippedActor').mockResolvedValue(next)
  const d = {
    player: first,
    equipmentEpoch: 0,
    game: {},
    c: { hud: { fake: () => undefined } },
  } as unknown as NativeDirector
  try {
    dressForHub(d, DEFAULT_LOADOUT, {})
    await flush()
    expect(d.player).toBe(next)
    expect(next.root.getRotation().equals(rotation)).toBe(true)
    dressForHub(d, DEFAULT_LOADOUT, {})
    dressForHub(
      d,
      {
        ...DEFAULT_LOADOUT,
        frame: 'frame.midnight',
        drawSound: 'sound.cannon-boom',
        saddlebag: 'bag.medal-satchel',
      },
      {},
    )
    await flush()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(d.player).toBe(next)
  } finally {
    first.destroy()
    next.destroy()
  }
})

function previewFixture(textureReady: Promise<void> = Promise.resolve()) {
  const device = new NullGraphicsDevice()
  let disposed = false
  const stage = new Entity('stage')
  const player = rider('player')
  stage.addChild(player.root)
  const textures = new Map<string, Texture>()
  const materials: StandardMaterial[] = []
  const pending: {
    url: string
    resolve: (asset: unknown) => void
    reject: (error: Error) => void
  }[] = []
  const released: string[] = []
  const instances: Entity[] = []
  const errors: string[] = []
  const resource = () => {
    const material = new StandardMaterial()
    materials.push(material)
    return {
      materials: [{ resource: material }],
      data: { gltf: { materials: [{ extras: { nativePbr: { albedo: 'bag-albedo' } } }] } },
      instantiateRenderEntity: () => {
        const entity = new Entity('native-bag-instance')
        instances.push(entity)
        return entity
      },
    }
  }
  const game = {
    stage,
    loadContainer: (url: string) =>
      new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
    releaseContainer: (url: string) => released.push(url),
    loadTexture: async (url: string) => {
      await textureReady
      const texture = new Texture(device, { name: url, width: 1, height: 1 })
      textures.set(url, texture)
      return { resource: texture }
    },
    releaseTexture: (url: string) => {
      textures.get(url)?.destroy()
      textures.delete(url)
    },
  } as unknown as GameApplication
  const d = {
    game,
    player,
    c: { hud: { fake: (message: string) => errors.push(message) } },
  } as unknown as NativeDirector
  const preview = new NativeOutfitter(d)
  return {
    preview,
    device,
    d,
    pending,
    released,
    instances,
    textures,
    errors,
    complete: (index: number) => {
      pending[index]?.resolve({ resource: resource() })
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      preview.destroy()
      stage.destroy()
      for (const material of materials) {
        material.destroy()
      }
      device.destroy()
    },
  }
}

it('all four catalogue bag choices share the live drop ordering and use the matching native preview', async () => {
  expect(CATALOG.filter((item) => item.slot === 'saddlebag').map((item) => item.id)).toEqual([
    ...BAG_STYLES,
  ])
  const f = previewFixture()
  try {
    for (const [index, id] of BAG_STYLES.entries()) {
      f.preview.show(id)
      await flush()
      const key = `bag${index}` as 'bag0' | 'bag1' | 'bag2' | 'bag3'
      expect(f.pending[index]?.url).toBe(DYNAMIC_ASSETS[key].url)
      f.complete(index)
      await flush()
      expect(f.instances.at(-1)?.name).toBe(`outfitter-${key}`)
      expect(f.textures.size).toBe(1)
    }
    f.preview.show(null)
    expect(f.textures.size).toBe(0)
    expect(f.released).toHaveLength(4)
    expect(f.errors).toEqual([])
  } finally {
    f.dispose()
  }
})

it('close during a pending load cannot resurrect a bag or retain its container', async () => {
  const f = previewFixture()
  f.preview.show('bag.medal-satchel')
  await flush()
  f.preview.destroy()
  f.complete(0)
  await flush()
  expect(f.instances).toHaveLength(0)
  expect(f.released).toEqual([DYNAMIC_ASSETS.bag3.url])
  expect(f.textures.size).toBe(0)
  expect(f.errors).toEqual([])
  f.dispose()
})

it('rapid bag A to B to A retires the first lease before loading the current A', async () => {
  const f = previewFixture()
  try {
    f.preview.show('bag.plain-sack')
    await flush()
    f.preview.show('bag.branded-satchel')
    f.preview.show('bag.plain-sack')
    f.complete(0)
    await flush()
    expect(f.pending.map((request) => request.url)).toEqual([
      DYNAMIC_ASSETS.bag0.url,
      DYNAMIC_ASSETS.bag0.url,
    ])
    expect(f.released).toEqual([DYNAMIC_ASSETS.bag0.url])
    expect(f.instances).toHaveLength(0)
    f.complete(1)
    await flush()
    expect(f.instances).toHaveLength(1)
    expect(f.instances[0]?.name).toBe('outfitter-bag0')
    f.preview.rotate(55)
    const rotation = f.instances[0]?.getRotation().clone()
    f.preview.show(null)
    expect(f.d.player?.root.getRotation()).toEqual(rotation)
    expect(f.released).toEqual([DYNAMIC_ASSETS.bag0.url, DYNAMIC_ASSETS.bag0.url])
    expect(f.textures.size).toBe(0)
    expect(f.device.textures).toHaveLength(0)
    expect(new Set(f.device.buffers)).toEqual(
      new Set([f.device.quadVertexBuffer, f.device.quadIndexBuffer]),
    )
    f.dispose()
    expect(f.device.buffers.size).toBe(0)
  } finally {
    f.dispose()
  }
})

it('close during actual native material preparation releases late textures and never adds a bag', async () => {
  let ready!: () => void
  const gate = new Promise<void>((resolve) => {
    ready = resolve
  })
  const f = previewFixture(gate)
  try {
    f.preview.show('bag.medal-satchel')
    await flush()
    f.complete(0)
    await flush()
    f.preview.destroy()
    ready()
    await flush()
    expect(f.instances).toHaveLength(0)
    expect(f.released).toEqual([DYNAMIC_ASSETS.bag3.url])
    expect(f.textures.size).toBe(0)
    expect(f.device.textures).toHaveLength(0)
    expect(new Set(f.device.buffers)).toEqual(
      new Set([f.device.quadVertexBuffer, f.device.quadIndexBuffer]),
    )
    f.dispose()
    expect(f.device.buffers.size).toBe(0)
    expect(f.errors).toEqual([])
  } finally {
    ready()
    f.dispose()
  }
})

it('a native PBR failure retires the bag container and is reported without an unhandled rejection', async () => {
  let fail!: (error: Error) => void
  const gate = new Promise<void>((_resolve, reject) => {
    fail = reject
  })
  const f = previewFixture(gate)
  try {
    f.preview.show('bag.medal-satchel')
    await flush()
    f.complete(0)
    await flush()
    fail(new Error('Injected bag texture failure'))
    await flush()
    expect(f.instances).toHaveLength(0)
    expect(f.released).toEqual([DYNAMIC_ASSETS.bag3.url])
    expect(f.textures.size).toBe(0)
    expect(f.device.textures).toHaveLength(0)
    expect(f.errors).toEqual(['Injected bag texture failure'])
  } finally {
    f.dispose()
  }
})

it('latest dressing wins while native yaw changes and repeated pending requests do not rebuild', async () => {
  const first = rider('initial')
  const late = rider('late')
  const latest = rider('latest')
  let deliver!: (value: DuelActor) => void
  const pending = new Promise<DuelActor>((resolve) => {
    deliver = resolve
  })
  const factory = spyOn(equipment, 'equippedActor')
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(latest)
  const retired = spyOn(late, 'destroy')
  const d = {
    player: first,
    equipmentEpoch: 0,
    game: {},
    c: { hud: { fake: () => undefined } },
  } as unknown as NativeDirector
  const preview = new NativeOutfitter(d)
  try {
    preview.enter()
    preview.rotate(95)
    const rotation = first.root.getRotation().clone()
    dressForHub(d, DEFAULT_LOADOUT, {})
    dressForHub(d, DEFAULT_LOADOUT, {})
    expect(factory).toHaveBeenCalledTimes(1)
    dressForHub(d, { ...DEFAULT_LOADOUT, extra: 'extra.tin-star' }, {})
    await flush()
    expect(d.player).toBe(latest)
    expect(latest.root.getRotation().equals(rotation)).toBe(true)
    deliver(late)
    await flush()
    expect(d.player).toBe(latest)
    expect(retired).toHaveBeenCalledTimes(1)
    preview.rotate(-30)
    expect(latest.root.getRotation().equals(rotation)).toBe(false)
  } finally {
    deliver(late)
    preview.destroy()
    first.destroy()
    latest.destroy()
    late.destroy()
  }
})

it('a failed bag load can retry the same selection and then retire normally', async () => {
  const f = previewFixture()
  try {
    f.preview.show('bag.medal-satchel')
    await flush()
    f.pending[0]?.reject(new Error('Injected bag download failure'))
    await flush()
    expect(f.errors).toEqual(['Injected bag download failure'])
    f.preview.show('bag.medal-satchel')
    await flush()
    expect(f.pending).toHaveLength(2)
    f.complete(1)
    await flush()
    expect(f.instances).toHaveLength(1)
    f.preview.show(null)
    expect(f.released).toEqual([DYNAMIC_ASSETS.bag3.url])
    expect(f.textures.size).toBe(0)
    f.dispose()
    expect(f.device.textures).toHaveLength(0)
    expect(f.device.buffers.size).toBe(0)
  } finally {
    f.dispose()
  }
})
