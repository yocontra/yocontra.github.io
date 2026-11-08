import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
  new URL('../../public/experiments/out-west/sw.js', import.meta.url),
  'utf8',
)
const origin = 'https://example.test'
type LifetimeHandler = (event: { waitUntil: (work: Promise<unknown>) => void }) => void

it('native cache activation preserves downloaded assets and fresh shell without touching other apps', async () => {
  const previous = new Map<string, Response>([
    [`${origin}/experiments/out-west/vendor/basis/2.23.3/basis.wasm.js`, new Response('decoder')],
    [`${origin}/experiments/out-west/3d/native-v2/map.ktx2`, new Response('compressed texture')],
    [`${origin}/experiments/out-west/ui/wood.webp`, new Response('old wood')],
    [
      `${origin}/experiments/out-west/frontier/`,
      new Response('old html', { headers: { 'content-type': 'text/html' } }),
    ],
    [`${origin}/experiments/out-west/failed.wasm`, new Response('failed', { status: 503 })],
    [`${origin}/outside-app/image.png`, new Response('unrelated')],
    ['https://other.test/experiments/out-west/image.png', new Response('other origin')],
  ])
  const stores = new Map<string, Map<string, Response>>([
    ['out-west-ow-v2', previous],
    ['other-app-v1', new Map()],
  ])
  const listeners = new Map<string, LifetimeHandler>()
  let claimed = false
  let skippedWaiting = false
  runInNewContext(source, {
    URL,
    self: {
      location: { origin },
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
        const entries = stores.get(name) ?? new Map<string, Response>()
        stores.set(name, entries)
        return Promise.resolve({
          add: (path: string) => {
            entries.set(`${origin}${path}`, new Response(`new ${path}`))
            return Promise.resolve()
          },
          keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
          match: (request: Request) => Promise.resolve(entries.get(request.url)?.clone()),
          put: (request: Request, response: Response) => {
            entries.set(request.url, response.clone())
            return Promise.resolve()
          },
        })
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (key: string) => Promise.resolve(stores.delete(key)),
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
  expect(stores.has('out-west-ow-v2')).toBe(true)
  await dispatch('activate')
  expect(claimed).toBe(true)
  expect(stores.has('out-west-ow-v2')).toBe(false)
  expect(stores.has('other-app-v1')).toBe(true)
  const current = stores.get('out-west-ow-playcanvas-v2-visual-repair')
  expect(current).toBeDefined()
  expect(
    await current?.get(`${origin}/experiments/out-west/vendor/basis/2.23.3/basis.wasm.js`)?.text(),
  ).toBe('decoder')
  expect(await current?.get(`${origin}/experiments/out-west/3d/native-v2/map.ktx2`)?.text()).toBe(
    'compressed texture',
  )
  expect(await current?.get(`${origin}/experiments/out-west/ui/wood.webp`)?.text()).toBe(
    'new /experiments/out-west/ui/wood.webp',
  )
  expect(current?.has(`${origin}/experiments/out-west/frontier/`)).toBe(false)
  expect(current?.has(`${origin}/experiments/out-west/failed.wasm`)).toBe(false)
  expect(current?.has(`${origin}/outside-app/image.png`)).toBe(false)
  expect(current?.has('https://other.test/experiments/out-west/image.png')).toBe(false)
})
