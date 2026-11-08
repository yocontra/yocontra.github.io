import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
  new URL('../../public/experiments/out-west/sw.js', import.meta.url),
  'utf8',
)

type LifetimeHandler = (event: { waitUntil: (work: Promise<unknown>) => void }) => void

it('native service worker activates a fresh cache without deleting other applications', async () => {
  const keys = new Set(['out-west-ow-v2', 'other-app-v1'])
  const listeners = new Map<string, LifetimeHandler>()
  let claimed = false
  let skippedWaiting = false
  const added: string[] = []
  runInNewContext(source, {
    self: {
      addEventListener: (name: string, listener: LifetimeHandler) => listeners.set(name, listener),
      clients: {
        claim: () => {
          claimed = true
        },
      },
      skipWaiting: () => {
        skippedWaiting = true
      },
    },
    caches: {
      open: (name: string) => {
        keys.add(name)
        return Promise.resolve({
          add: (url: string) => {
            added.push(url)
            return Promise.resolve()
          },
        })
      },
      keys: () => Promise.resolve([...keys]),
      delete: (key: string) => Promise.resolve(keys.delete(key)),
    },
  })
  const dispatch = async (name: string): Promise<void> => {
    let work = Promise.resolve<unknown>(undefined)
    const handler = listeners.get(name)
    expect(handler).toBeDefined()
    handler?.({
      waitUntil: (pending) => {
        work = pending
      },
    })
    await work
  }
  await dispatch('install')
  expect(skippedWaiting).toBe(false)
  expect(keys.has('out-west-ow-v2')).toBe(true)
  expect(added).toContain('/experiments/out-west/')
  await dispatch('activate')
  expect(claimed).toBe(true)
  expect(keys.has('out-west-ow-v2')).toBe(false)
  expect(keys.has('other-app-v1')).toBe(true)
  expect([...keys].filter((key) => key.startsWith('out-west-'))).toEqual([
    'out-west-ow-playcanvas-v1',
  ])
})
