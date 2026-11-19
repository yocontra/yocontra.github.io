import { afterAll, beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import {
  AppBase,
  AppOptions,
  Entity,
  NullGraphicsDevice,
  RenderComponentSystem,
  SoundComponentSystem,
  type SoundInstance,
} from 'playcanvas'
import { initializeAmmo } from '../../packages/durable-game-runtime/src/ammo.ts'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { NativeRagdolls } from '../../src/experiments/out-west/client/ragdolls.ts'
import { BreakableWindows } from '../../src/experiments/out-west/client/windows.ts'
import type { GlassPlane } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'

const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
beforeAll(async () => {
  if (!priorDocument) {
    Object.defineProperty(globalThis, 'document', {
      value: Object.assign(new EventTarget(), { hidden: false }),
      configurable: true,
    })
  }
  await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})

afterAll(() => {
  if (!priorDocument) {
    Reflect.deleteProperty(globalThis, 'document')
  }
})

const planes: GlassPlane[] = [{ index: 0, axis: 0, at: 3, a0: 0, a1: 1, y0: 0.5, y1: 1.5 }]
const shatter = { type: 'glass_break', window: 0 } as const

async function setup() {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem, SoundComponentSystem]
  app.init(options)
  const stage = new Entity('stage', app)
  const camera = new Entity('camera', app)
  const pane = new Entity('glass-0', app)
  app.root.addChild(stage)
  stage.addChild(camera)
  stage.addChild(pane)
  pane.addComponent('render', { type: 'box' })
  const game = {
    app,
    stage,
    camera,
    loadAudio: () => Promise.reject(new Error('No Web Audio in the native fixture')),
  } as unknown as GameApplication
  const windows = new BreakableWindows(stage)
  const ragdolls = await NativeRagdolls.create(game, {
    version: 'glass-fixture',
    boxes: [],
    meshes: [],
  })
  windows.shatterInto(game, ragdolls)
  const physics = ragdolls.share(() => false)
  const physicsDevice = physics.app.graphicsDevice
  const sound = (stage.findByName('glass-shatter') as Entity | null)?.sound
  if (!sound) {
    throw new Error('Missing native shatter speaker')
  }
  windows.update(Uint8Array.of(0), planes)
  const update = () => {
    app.fire('update', 1 / 60)
    app.fire('prerender')
  }
  return {
    pane,
    windows,
    update,
    sound,
    bodies: () => physics.app.root.findByName('glass-shard'),
    destroy() {
      windows.destroy()
      ragdolls.destroy()
      app.destroy()
      device.destroy()
      return {
        buffers: device.buffers.size,
        textures: device._vram.tex,
        physicsBuffers: physicsDevice.buffers.size,
        physicsTextures: physicsDevice._vram.tex,
      }
    },
  }
}

it('restores an intact replacement pane after an old shatter led its snapshot', async () => {
  const f = await setup()
  try {
    f.windows.event(shatter)
    f.update()
    expect(f.pane.enabled).toBe(false)
    expect(f.windows.stats().shards).toBeGreaterThan(0)
    expect(f.bodies()).not.toBeNull()
    f.windows.reset()
    expect(f.pane.enabled).toBe(true)
    f.windows.update(Uint8Array.of(0), planes)
    expect(f.pane.enabled).toBe(true)
    expect(f.windows.stats().shards).toBe(0)
    expect(f.bodies()).toBeNull()
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0, physicsBuffers: 0, physicsTextures: 0 })
  }
})

it('clears a queued old break and stops overlapping sound instances on reconnect', async () => {
  const f = await setup()
  try {
    f.windows.event(shatter)
    let stopped = 0
    const stop = () => {
      stopped++
    }
    for (const slot of Object.values(f.sound.slots)) {
      slot.instances.push({ stop } as unknown as SoundInstance)
    }
    f.windows.reset()
    expect(stopped).toBe(Object.keys(f.sound.slots).length)
    expect(Object.values(f.sound.slots).every((slot) => slot.instances.length === 0)).toBe(true)
    f.windows.update(Uint8Array.of(0), planes)
    f.update()
    expect(f.pane.enabled).toBe(true)
    expect(f.windows.stats().shards).toBe(0)
    f.windows.event(shatter)
    f.update()
    expect(f.pane.enabled).toBe(false)
    expect(f.windows.stats().shards).toBeGreaterThan(0)
    f.windows.update(Uint8Array.of(1), planes)
    f.windows.reset()
    expect(f.pane.enabled).toBe(false)
    f.windows.update(Uint8Array.of(0), planes)
    expect(f.pane.enabled).toBe(true)
  } finally {
    expect(f.destroy()).toEqual({ buffers: 0, textures: 0, physicsBuffers: 0, physicsTextures: 0 })
  }
})
