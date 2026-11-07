import { describe, expect, it } from 'bun:test'
import {
  isResourceReleasedError,
  ResourceCache,
} from '../src/experiments/out-west/ffa/scene/crowd/resource-cache.ts'

const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('crowd bake residency', () => {
  it('pins 32 mixed riders across repeated lobby churn and keeps only four idle bakes', async () => {
    const disposed = new Set<string>()
    const cache = new ResourceCache({
      idleLimit: 4,
      dispose: (value: { key: string }) => disposed.add(value.key),
    })
    const keys = Array.from({ length: 32 }, (_, i) => `outfit-${i}`)
    await Promise.all(keys.map((key) => cache.acquire(key, async () => ({ key }))))
    expect(cache.stats.active).toBe(32)
    expect(disposed.size).toBe(0)
    const changeNext = async (change: number): Promise<void> => {
      if (change >= 6 * keys.length) {
        return
      }
      const rider = change % keys.length
      const wave = Math.floor(change / keys.length)
      const previous = keys[rider] as string
      const next = `wave-${wave}-rider-${rider}`
      // The replacement becomes drawable before the old mesh releases its pin.
      await cache.acquire(next, async () => ({ key: next }))
      cache.release(previous)
      keys[rider] = next
      expect(cache.stats.active).toBe(32)
      expect(cache.stats.idle).toBeLessThanOrEqual(4)
      for (const active of keys) {
        expect(disposed.has(active)).toBe(false)
      }
      await changeNext(change + 1)
    }
    await changeNext(0)
    for (const key of keys) {
      cache.release(key)
    }
    expect(cache.stats.active).toBe(0)
    expect(cache.stats.idle).toBe(4)
    expect(disposed.size).toBe(32 * 7 - 4)
  })

  it('deduplicates simultaneous users and evicts the least recently released idle resource', async () => {
    const disposed: string[] = []
    const cache = new ResourceCache({
      idleLimit: 1,
      dispose: (value: string) => disposed.push(value),
    })
    let loads = 0
    const a = cache.acquire('a', () => {
      loads++
      return Promise.resolve('a')
    })
    const alsoA = cache.acquire('a', async () => 'wrong')
    expect(a).toBe(alsoA)
    await a
    cache.release('a')
    expect(cache.stats.references).toBe(1)
    await cache.acquire('b', async () => 'b')
    cache.release('b')
    expect(disposed).toEqual([])
    cache.release('a')
    expect(disposed).toEqual(['b'])
    expect(loads).toBe(1)
  })

  it('serializes bakes, cancels abandoned queued work, and releases in-flight results safely', async () => {
    const disposed: string[] = []
    const cache = new ResourceCache({
      idleLimit: 0,
      dispose: (value: string) => disposed.push(value),
    })
    const gate = Promise.withResolvers<string>()
    let firstStarted = false
    const first = cache.acquire('first', () => {
      firstStarted = true
      return gate.promise
    })
    let secondStarted = false
    const second = cache.acquire('second', () => {
      secondStarted = true
      return Promise.resolve('second')
    })
    const cancelled = second.catch((error: unknown) => error)
    await turn()
    expect(firstStarted).toBe(true)
    expect(secondStarted).toBe(false)
    expect(cache.stats.loading).toBe(1)
    cache.release('second')
    expect(isResourceReleasedError(await cancelled)).toBe(true)
    cache.release('first')
    gate.resolve('first')
    await first
    expect(secondStarted).toBe(false)
    expect(disposed).toEqual(['first'])
    expect(cache.stats.active).toBe(0)
    expect(cache.stats.idle).toBe(0)
  })

  it('removes failed loads so a later acquisition can retry', async () => {
    const cache = new ResourceCache<string>({ idleLimit: 4, dispose: () => undefined })
    await expect(
      cache.acquire('retry', async () => Promise.reject(new Error('failed'))),
    ).rejects.toThrow('failed')
    expect(cache.stats.active).toBe(0)
    expect(await cache.acquire('retry', async () => 'ready')).toBe('ready')
    cache.release('retry')
    expect(cache.stats.idle).toBe(1)
  })

  it('shrinks the floor-tier idle allowance without evicting any live rider resource', async () => {
    const disposed: string[] = []
    const cache = new ResourceCache({
      idleLimit: 4,
      dispose: (value: string) => disposed.push(value),
    })
    const keys = ['idle-a', 'idle-b', 'idle-c', 'idle-d', 'active']
    await Promise.all(keys.map((key) => cache.acquire(key, async () => key)))
    for (const key of keys.slice(0, 4)) {
      cache.release(key)
    }
    cache.setIdleLimit(1)
    expect(cache.stats.active).toBe(1)
    expect(cache.stats.idle).toBe(1)
    expect(disposed).toEqual(['idle-a', 'idle-b', 'idle-c'])
    cache.release('active')
    expect(disposed).not.toContain('active')
    expect(cache.stats.idle).toBe(1)
  })
})
