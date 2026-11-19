import { beforeAll, expect, test as it } from 'bun:test'
import { createRequire } from 'node:module'
import { file } from 'bun'
import { initializeAmmo } from '../../packages/durable-game-runtime/src/ammo.ts'
import { COLLISION } from '../../src/experiments/out-west/runtime/collision.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

const require = createRequire(import.meta.url)
const [production, debug, profiler] = await Promise.all([
  import('playcanvas'),
  import('playcanvas/debug'),
  import('playcanvas/profiler'),
])
const builds = {
  production,
  debug,
  profiler,
  'require-production': require('playcanvas') as typeof production,
  'require-debug': require('playcanvas/debug') as typeof production,
  'require-profiler': require('playcanvas/profiler') as typeof production,
}

for (const [name, pc] of Object.entries(builds)) {
  for (const initialData of [false, true]) {
    it(`${name}: real Null buffers release constructor-accounted bytes once, including typed subviews (${initialData})`, () => {
      const device = new pc.NullGraphicsDevice()
      const baseline = { ...device._vram }
      const count = device.buffers.size
      const format = new pc.VertexFormat(device, [
        { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
      ])
      const vertices = new Float32Array(new ArrayBuffer(128), 16, 12)
      const indices = new Uint16Array(new ArrayBuffer(64), 8, 6)
      const vb = new pc.VertexBuffer(
        device,
        format,
        4,
        initialData ? { data: vertices } : undefined,
      )
      const ib = new pc.IndexBuffer(
        device,
        pc.INDEXFORMAT_UINT16,
        6,
        pc.BUFFER_STATIC,
        initialData ? indices : undefined,
      )
      try {
        expect(device.buffers.size).toBe(count + 2)
        expect(device._vram.vb - baseline.vb).toBe(48)
        expect(device._vram.ib - baseline.ib).toBe(12)
        // Actual setData/unlock paths run on the stock Null backend, which creates no GPU handle.
        expect(vb.setData(vertices)).toBe(true)
        expect(ib.setData(indices)).toBe(true)
        expect(Object.is(vb.storage, vertices)).toBe(true)
        expect(Object.is(ib.storage, indices)).toBe(true)
        // Null has no GPU bind call. Seed the native binding slot consumed by IndexBuffer.destroy.
        Reflect.set(device, 'indexBuffer', ib)
        expect(Reflect.get(device, 'indexBuffer')).toBe(ib)
        vb.destroy()
        ib.destroy()
        expect(device.buffers.size).toBe(count)
        expect(device._vram).toEqual(baseline)
        expect(Reflect.get(device, 'indexBuffer')).toBeNull()
        vb.destroy()
        ib.destroy()
        expect(device._vram).toEqual(baseline)
        const other = new pc.IndexBuffer(device, pc.INDEXFORMAT_UINT16, 3)
        Reflect.set(device, 'indexBuffer', other)
        ib.destroy()
        expect(Reflect.get(device, 'indexBuffer')).toBe(other)
        other.destroy()
        expect(Reflect.get(device, 'indexBuffer')).toBeNull()
        expect(device._vram).toEqual(baseline)
      } finally {
        vb.destroy()
        ib.destroy()
        device.destroy()
      }
      expect(device.buffers.size).toBe(0)
      expect(device._vram.vb).toBe(0)
      expect(device._vram.ib).toBe(0)
    })
  }
  it(`${name}: never-uploaded allocated native buffers and built-in quad leave exact zero counters`, () => {
    const device = new pc.NullGraphicsDevice()
    const format = new pc.VertexFormat(device, [
      { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
    ])
    const vb = new pc.VertexBuffer(device, format, 3)
    const ib = new pc.IndexBuffer(device, pc.INDEXFORMAT_UINT32, 3)
    expect(vb.numBytes).toBe(36)
    expect(ib.numBytes).toBe(12)
    vb.destroy()
    ib.destroy()
    device.destroy()
    expect(device.buffers.size).toBe(0)
    expect(device.textures.size).toBe(0)
    expect(device._vram.vb).toBe(0)
    expect(device._vram.ib).toBe(0)
  })
}

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
it('actual full collision simulations dispose all native buffers and counters repeatedly, with and without response IDs', () => {
  for (const response of [false, true]) {
    const collision = response
      ? COLLISION
      : {
          ...COLLISION,
          boxes: COLLISION.boxes.map(({ id: _id, ...box }) => box),
          meshes: COLLISION.meshes.map(({ id: _id, ...mesh }) => mesh),
        }
    for (let iteration = 0; iteration < 3; iteration++) {
      const simulation = createSimulation({ ammo, collision })
      const device = simulation.app.graphicsDevice
      expect(device.buffers.size).toBeGreaterThan(2)
      expect(device._vram.vb).toBeGreaterThan(32)
      expect(device._vram.ib).toBeGreaterThan(12)
      simulation.dispose()
      expect(device.buffers.size).toBe(0)
      expect(device.textures.size).toBe(0)
      expect(device._vram.vb).toBe(0)
      expect(device._vram.ib).toBe(0)
      simulation.dispose()
      expect(device._vram.vb).toBe(0)
      expect(device._vram.ib).toBe(0)
    }
  }
})
