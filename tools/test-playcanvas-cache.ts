/** Actual browser upgrade: waiting worker, preserved legacy assets and offline native decoders/maps. */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from 'playwright'

const publicRoot = resolve('public')
const workerSource = await readFile(`${publicRoot}/experiments/out-west/sw.js`, 'utf8')
const output = process.env.OW_CACHE_OUTPUT ?? '/tmp/out-west-native-cache'
const oldVersion = 'ow-browser-before-repair'
const versionDeclaration = /const VERSION = '[^']+'/u
const newVersion = /const VERSION = '(?<version>[^']+)'/u.exec(workerSource)?.groups?.version
if (!newVersion || newVersion === oldVersion) {
  throw new Error('The service-worker release version is missing')
}
const texture = (await readdir(`${publicRoot}/experiments/out-west/3d/native-v2/characters`))
  .sort()
  .find((name) => name.endsWith('.color.ktx2'))
if (!texture) {
  throw new Error('Native KTX2 content is missing')
}
const paths = [
  '/experiments/out-west/vendor/basis/2.23.3/basis.wasm.js',
  '/experiments/out-west/vendor/basis/2.23.3/basis.wasm.wasm',
  `/experiments/out-west/3d/native-v2/characters/${texture}`,
  '/experiments/out-west/3d/equipment/gun.rusty-six.glb',
]
const expected = await Promise.all(
  paths.map(async (path) =>
    createHash('sha256')
      .update(await readFile(`${publicRoot}${path}`))
      .digest('hex'),
  ),
)
let published = false
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/experiments/out-west/sw.js') {
      return new Response(
        published
          ? workerSource
          : workerSource.replace(versionDeclaration, `const VERSION = '${oldVersion}'`),
        { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } },
      )
    }
    if (path === '/observer' || path.endsWith('/')) {
      return new Response(`<!doctype html><body>cache-shell-${published ? 'new' : 'old'}</body>`, {
        headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
      })
    }
    try {
      return new Response(await readFile(`${publicRoot}${path}`), {
        headers: {
          'content-type': path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        },
      })
    } catch {
      return new Response('Missing asset', { status: 404 })
    }
  },
})
const origin = `http://127.0.0.1:${server.port}`
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext()
const errors: string[] = []
function inspect(page: Page): void {
  page.on('pageerror', (error) => errors.push(error.message))
}
function hashes(page: Page): Promise<string[]> {
  return page.evaluate(
    async (files) =>
      Promise.all(
        files.map(async (path) => {
          const response = await fetch(path)
          if (!response.ok) {
            throw new Error(`Asset status ${response.status}: ${path}`)
          }
          const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
          return [...new Uint8Array(hash)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        }),
      ),
    paths,
  )
}
function requireCache(condition: unknown, detail: string): asserts condition {
  if (!condition) {
    throw new Error(detail)
  }
}
try {
  const observer = await context.newPage()
  inspect(observer)
  await observer.goto(`${origin}/observer`)
  await observer.evaluate(async () => {
    const other = await caches.open('unrelated-app')
    await other.put('/unrelated-sentinel', new Response('keep'))
  })
  const page = await context.newPage()
  inspect(page)
  await page.goto(`${origin}/experiments/out-west/`)
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/experiments/out-west/sw.js', {
      scope: '/experiments/out-west/',
    })
    await navigator.serviceWorker.ready
  })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await page.evaluate(() =>
    Reflect.set(globalThis, '__originalController', navigator.serviceWorker.controller),
  )
  published = true
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update())
  await page.waitForFunction(async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  )
  // These late downloads include a legacy v1 GLB and the new decoder/maps served by the old worker.
  const before = await hashes(page)
  requireCache(
    JSON.stringify(before) === JSON.stringify(expected),
    'Waiting worker changed asset bytes',
  )
  await page.waitForFunction(
    async ({ files, name }) => {
      const cache = await caches.open(name)
      return (await Promise.all(files.map(async (path) => Boolean(await cache.match(path))))).every(
        Boolean,
      )
    },
    { files: paths, name: `out-west-${oldVersion}` },
  )
  requireCache(
    await page.evaluate(
      () => navigator.serviceWorker.controller === Reflect.get(globalThis, '__originalController'),
    ),
    'Update replaced an active client controller',
  )
  requireCache(
    (await page.textContent('body')) === 'cache-shell-old',
    'Update reloaded the active page',
  )
  await page.close()
  await observer.waitForFunction(async (name) => {
    const cache = await caches.open(name)
    const response = await cache.match('/experiments/out-west/')
    const reg = await navigator.serviceWorker.getRegistration('/experiments/out-west/')
    return (
      reg?.active?.state === 'activated' &&
      !reg.waiting &&
      (await response?.text())?.includes('cache-shell-new')
    )
  }, `out-west-${newVersion}`)
  await observer.waitForFunction(
    async ({ files, name }) => {
      const cache = await caches.open(name)
      return (await Promise.all(files.map(async (path) => Boolean(await cache.match(path))))).every(
        Boolean,
      )
    },
    { files: paths, name: `out-west-${newVersion}` },
  )
  await context.setOffline(true)
  const offline = await context.newPage()
  inspect(offline)
  await offline.goto(`${origin}/experiments/out-west/`)
  const after = await hashes(offline)
  requireCache(
    JSON.stringify(after) === JSON.stringify(expected),
    'Offline upgrade lost native assets or returned stale bytes',
  )
  requireCache(
    (await offline.textContent('body')) === 'cache-shell-new',
    'Old HTML replaced the new shell',
  )
  const remaining = await offline.evaluate(async () => ({
    keys: await caches.keys(),
    other: await (await caches.open('unrelated-app'))
      .match('/unrelated-sentinel')
      .then((response) => response?.text()),
  }))
  requireCache(remaining.other === 'keep', 'Upgrade touched another application cache')
  requireCache(errors.length === 0, `Browser errors: ${errors.join('; ')}`)
  await mkdir(output, { recursive: true })
  const result = { oldVersion, newVersion, paths, expected, before, after, remaining, errors }
  await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
  server.stop(true)
}
