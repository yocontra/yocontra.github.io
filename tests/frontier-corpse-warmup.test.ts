import { expect, it } from 'bun:test'
import { Group, MeshBasicMaterial, Vector3 } from 'three'
import type { CorpseRig } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { CorpseWarmup } from '../src/experiments/out-west/ffa/scene/crowd/corpse-warmup.ts'

function rig(dispose: () => void): CorpseRig {
  return {
    identity: 'retained-real-rig',
    root: new Group(),
    velocity: new Vector3(),
    links: [],
    floor: { value: 0 },
    pose: () => undefined,
    dispose,
  }
}

it('retains at most32 real warmed rigs and their program materials until replacement or game disposal', async () => {
  let captured = 0
  let disposed = 0
  let compiled = 0
  const warm = new CorpseWarmup(() => {
    captured++
    const material = new MeshBasicMaterial()
    material.addEventListener('dispose', () => disposed++)
    return Promise.resolve(rig(() => material.dispose()))
  })
  await warm.prepare(
    Array.from({ length: 40 }, (_, i) => i - 1),
    (roots) => {
      compiled++
      expect(roots).toHaveLength(32)
    },
    () => true,
  )
  expect(captured).toBe(32)
  expect(compiled).toBe(1)
  expect(warm.count).toBe(32)
  expect(disposed).toBe(0)
  await warm.prepare(
    [0, 0],
    () => {
      expect(disposed).toBe(0)
    },
    () => true,
  )
  expect(warm.count).toBe(1)
  expect(disposed).toBe(32)
  warm.dispose()
  warm.dispose()
  expect(disposed).toBe(33)
})

it('releases all arriving clones if reconnect invalidates an asynchronous warmup', async () => {
  let resolve: ((value: CorpseRig | null) => void) | undefined
  let disposed = 0
  let compiled = 0
  const warm = new CorpseWarmup(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = warm.prepare(
    [0],
    () => compiled++,
    () => true,
  )
  warm.invalidate()
  resolve?.(rig(() => disposed++))
  await pending
  expect(compiled).toBe(0)
  expect(disposed).toBe(1)
  expect(warm.count).toBe(0)
  warm.dispose()
})

it('keeps existing compiled programs if a replacement capture fails and releases its partial results', async () => {
  const failures = new Set<number>()
  let disposed = 0
  const warm = new CorpseWarmup((id) =>
    failures.has(id)
      ? Promise.reject(new Error('asset failed'))
      : Promise.resolve(rig(() => disposed++)),
  )
  await warm.prepare(
    [0],
    () => undefined,
    () => true,
  )
  failures.add(1)
  await expect(
    warm.prepare(
      [0, 1],
      () => undefined,
      () => true,
    ),
  ).rejects.toThrow('asset failed')
  expect(disposed).toBe(1)
  expect(warm.count).toBe(1)
  warm.dispose()
  expect(disposed).toBe(2)
})

it('never resurrects a disposed warm cache through compilation or a late capture', async () => {
  let disposed = 0
  let captures = 0
  const warm = new CorpseWarmup(() => {
    captures++
    return Promise.resolve(rig(() => disposed++))
  })
  await warm.prepare(
    [0],
    () => warm.dispose(),
    () => true,
  )
  expect(warm.count).toBe(0)
  expect(disposed).toBe(1)
  await warm.prepare(
    [0],
    () => undefined,
    () => true,
  )
  expect(captures).toBe(1)
})

it('draws every warmed variant despite gameplay frustum bounds, then restores culling even on compile failure', async () => {
  const source = rig(() => undefined)
  const child = new Group()
  child.frustumCulled = false
  source.root.add(child)
  const warm = new CorpseWarmup(() => Promise.resolve(source))
  const compile = () => {
    expect(source.root.frustumCulled).toBe(false)
    expect(child.frustumCulled).toBe(false)
  }
  await warm.prepare([0], compile, () => true)
  expect(source.root.frustumCulled).toBe(true)
  expect(child.frustumCulled).toBe(false)
  let failed = false
  try {
    await warm.prepare(
      [0],
      () => {
        compile()
        throw new Error('compile failed')
      },
      () => true,
    )
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
  expect(source.root.frustumCulled).toBe(true)
  expect(child.frustumCulled).toBe(false)
  warm.dispose()
})
