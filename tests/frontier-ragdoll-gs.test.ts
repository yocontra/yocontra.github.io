import { beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import { Body, ContactEquation, Sphere, Vec3, World } from 'cannon-es'
import { type GsInput, GsKernel } from '../src/experiments/out-west/ffa/scene/ragdoll-gs.ts'
import { loadGsKernel } from '../src/experiments/out-west/ffa/scene/ragdoll-gs-load.ts'
import { CorpseSolver } from '../src/experiments/out-west/ffa/scene/ragdoll-solver.ts'

let module: WebAssembly.Module
beforeAll(async () => {
  module = await WebAssembly.compile(
    await file(
      new URL('../src/experiments/out-west/ffa/scene/ragdoll-gs.wasm', import.meta.url),
    ).arrayBuffer(),
  )
})

function packet(count = 1): GsInput {
  const rows = new Float64Array(count * 24)
  for (let i = 0; i < count; i++) {
    rows[i * 24] = 1
    rows[i * 24 + 6] = -1
    rows[i * 24 + 18] = 1
    rows[i * 24 + 19] = 0.5
    rows[i * 24 + 21] = -1e6
    rows[i * 24 + 22] = 1e6
  }
  return {
    count,
    iterations: 24,
    tolerance: 1e-7,
    rows,
    indices: Int32Array.from({ length: count * 2 }, (_, i) => i % 2),
    velocities: new Float64Array(12),
    masses: new Float64Array([1, 1]),
    finite: new Uint8Array(count).fill(1),
  }
}

function kernel(): GsKernel {
  const value = GsKernel.create(module)
  if (!value) {
    throw new Error('The committed ABI kernel failed initialization')
  }
  return value
}

it('owns independent memory per world, grows views safely and releases it on disposal', () => {
  const a = kernel()
  const b = kernel()
  const initialBytes = a.bytes
  const input = packet(2000)
  expect(a.run(input)).not.toBeNull()
  expect(a.bytes).toBeGreaterThan(initialBytes)
  expect(b.bytes).toBe(initialBytes)
  const clean = packet()
  const other = packet()
  expect(a.run(clean)).toEqual(b.run(other))
  expect(clean.rows).toEqual(other.rows)
  expect(clean.velocities).toEqual(other.velocities)
  a.dispose()
  a.dispose()
  expect(a.bytes).toBe(0)
  expect(a.run(packet())).toBeNull()
  expect(b.run(packet())).not.toBeNull()
  b.dispose()
})

it('rejects a module without the exact ABI before it can touch any world state', async () => {
  const empty = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
  expect(GsKernel.create(empty)).toBeNull()
})

it('rejects unsafe counts, capacities, indices and unsupported mutable settings without writes', () => {
  const native = kernel()
  const changes = [
    { count: -1 },
    { count: 0.5 },
    { count: 2 },
    { count: Number.MAX_SAFE_INTEGER },
    { iterations: 1.5 },
    { iterations: Number.POSITIVE_INFINITY },
    { iterations: 2 ** 32 },
    { tolerance: Number.NaN },
    { tolerance: -1 },
    { indices: new Int32Array([-1, 1]) },
    { indices: new Int32Array([0, 2]) },
    { finite: new Uint8Array() },
    { velocities: new Float64Array(11) },
  ]
  for (const change of changes) {
    const input = { ...packet(), ...change }
    const rows = input.rows.slice()
    const velocity = input.velocities.slice()
    expect(native.run(input)).toBeNull()
    expect(input.rows).toEqual(rows)
    expect(input.velocities).toEqual(velocity)
  }
  expect(native.run(packet())).not.toBeNull()
  native.dispose()
})

function solve(iterations: number, tolerance: number, native: boolean) {
  const solver = new CorpseSolver(native ? module : null)
  solver.iterations = iterations
  solver.tolerance = tolerance
  const world = new World()
  const a = new Body({ mass: 0 })
  const b = new Body({ mass: 1, shape: new Sphere(0.1) })
  world.addBody(a)
  world.addBody(b)
  const row = new ContactEquation(a, b)
  row.ni.set(0, 1, 0)
  row.ri.copy(new Vec3())
  row.rj.set(0, -0.1, 0)
  solver.addEquation(row)
  const used = solver.solve(1 / 120, world)
  const result = {
    used,
    velocity: b.velocity.toArray(),
    spin: b.angularVelocity.toArray(),
    multiplier: row.multiplier,
  }
  solver.dispose()
  return result
}

it('preserves the JS iteration/tolerance contract when mutable settings cannot use the ABI', () => {
  for (const [iterations, tolerance] of [
    [2.5, 1e-7],
    [24, Number.NaN],
    [24, Number.POSITIVE_INFINITY],
    [24, -1],
  ]) {
    expect(solve(iterations ?? 0, tolerance ?? 0, true)).toEqual(
      solve(iterations ?? 0, tolerance ?? 0, false),
    )
  }
})

it('bounds a stuck compile and ignores its late module instead of caching a timed-out result', async () => {
  let complete: (value: WebAssembly.Module) => void = () => undefined
  const delayed = new Promise<WebAssembly.Module>((resolve) => {
    complete = resolve
  })
  const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array()))
  const compiler = spyOn(WebAssembly, 'compile').mockImplementationOnce(() => delayed)
  try {
    expect(await loadGsKernel()).toBeNull()
    compiler.mockRestore()
    complete(module)
    await Promise.resolve()
    fetcher.mockRejectedValueOnce(new Error('offline'))
    expect(await loadGsKernel()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally {
    compiler.mockRestore()
    fetcher.mockRestore()
  }
}, 10_000)

it('falls back on transport/invalid bytes and shares only the successfully compiled module', async () => {
  const bytes = await file(
    new URL('../src/experiments/out-west/ffa/scene/ragdoll-gs.wasm', import.meta.url),
  ).arrayBuffer()
  const fetcher = spyOn(globalThis, 'fetch')
  try {
    fetcher.mockRejectedValueOnce(new Error('offline'))
    expect(await loadGsKernel()).toBeNull()
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await loadGsKernel()).toBeNull()
    fetcher.mockResolvedValueOnce(new Response('not a wasm module'))
    expect(await loadGsKernel()).toBeNull()
    fetcher.mockResolvedValueOnce(new Response(bytes))
    const first = loadGsKernel()
    const second = loadGsKernel()
    expect(first).toBe(second)
    const ready = await first
    expect(ready).toBeInstanceOf(WebAssembly.Module)
    expect(await loadGsKernel()).toBe(ready)
    expect(fetcher).toHaveBeenCalledTimes(4)
  } finally {
    fetcher.mockRestore()
  }
})
