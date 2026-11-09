/** Run with `bun tools/content/asset-retry.ts`: real WebGL/KTX2 retries on an isolated local server. */
import { chromium } from 'playwright'

const root = new URL('../../', import.meta.url)
const fixture = Bun.file(
  new URL(
    'public/experiments/out-west/3d/native-v2/environments/textures/8fe1426e73a8c7f6dce983e9.color.ktx2',
    root,
  ),
)
const header = new DataView(await fixture.arrayBuffer())
const dimensions = { width: header.getUint32(20, true), height: header.getUint32(24, true) }
const build = await Bun.build({
  entrypoints: [new URL('src/experiments/out-west/client/application.ts', root).pathname],
  target: 'browser',
  define: { 'import.meta.env': '{}' },
})
if (!build.success) {
  throw new Error(build.logs.join('\n'))
}
const bundle = build.outputs[0]
if (!bundle) {
  throw new Error('Missing application bundle')
}
const attempts = new Map<string, number>()
const failures = new Map([
  ['/transient.ktx2', 5],
  ['/terminal.ktx2', 6],
  ['/control.ktx2', 1],
])
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    const limit = failures.get(path)
    if (limit !== undefined) {
      const count = (attempts.get(path) ?? 0) + 1
      attempts.set(path, count)
      return new Response(count <= limit ? 'Transient asset outage' : fixture, {
        status: count <= limit ? 503 : 200,
        headers: { 'cache-control': 'no-store', 'content-type': 'image/ktx2' },
      })
    }
    if (path === '/application.js') {
      return new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
    }
    if (
      path.startsWith('/experiments/out-west/vendor/basis/2.23.3/') ||
      path === '/experiments/out-west/3d/env/sky-noon.hdr'
    ) {
      return new Response(Bun.file(new URL(`public${path}`, root)))
    }
    return path === '/'
      ? new Response('<!doctype html><title>Native asset retry regression</title>', {
          headers: { 'content-type': 'text/html' },
        })
      : new Response('Not found', { status: 404 })
  },
})
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url.href)
    const result = await page.evaluate(async (expected) => {
      const modulePath = '/application.js'
      const {
        GameApplication,
      }: typeof import('../../src/experiments/out-west/client/application.ts') = await import(
        /* @vite-ignore */ modulePath
      )
      const viewport = document.createElement('div')
      viewport.style.cssText = 'width:64px;height:64px'
      const canvas = document.createElement('canvas')
      viewport.append(canvas)
      document.body.append(viewport)
      const game = await GameApplication.create({ canvas, viewport })
      const check = (condition: unknown, message: string): void => {
        if (!condition) {
          throw new Error(message)
        }
      }
      const baseline = game.app.assets.list().length
      const empty = (url: string): void => {
        check(
          game.app.assets.find(url) === null,
          `Failed/released asset remains registered: ${url}`,
        )
        check(!game.app.loader.getFromCache(url, 'texture'), `Loader retained ${url}`)
        check(game.app.assets.list().length === baseline, `Asset registry grew after ${url}`)
      }
      const reject = async (url: string): Promise<string> => {
        try {
          await game.loadTexture(url)
        } catch (error) {
          check(error instanceof Error && error.message.includes(url), `Missing failure: ${url}`)
          empty(url)
          return String(error)
        }
        throw new Error(`Expected terminal failure: ${url}`)
      }
      const released = async (url: string): Promise<void> => {
        const asset = await game.loadTexture(url)
        const texture = asset.resource as import('playcanvas').Texture
        check(
          texture.width === expected.width && texture.height === expected.height,
          `KTX parser returned incorrect dimensions: ${url}`,
        )
        check(Boolean(texture.device), `Texture has no native graphics device: ${url}`)
        game.releaseTexture(url)
        await Promise.resolve()
        empty(url)
        check(!texture.device, `Released texture still owns its graphics device: ${url}`)
      }
      try {
        // AppBase.init enables five native retries; the sixth failure must exhaust that budget.
        await released('/transient.ktx2')
        const first = game.loadTexture('/terminal.ktx2')
        check(first === game.loadTexture('/terminal.ktx2'), 'Pending loads were not coalesced')
        const terminal = await reject('/terminal.ktx2')
        // The seventh HTTP request succeeds only if terminal failure evicted the rejected promise.
        await released('/terminal.ktx2')
        game.app.loader.disableRetry()
        const control = await reject('/control.ktx2')
        return { dimensions: expected, control, terminal, released: true, terminalReacquired: true }
      } finally {
        const loader = game.app.loader
        game.destroy()
        check(!loader.getHandler('texture'), 'Destroyed application retained its native handler')
        viewport.remove()
      }
    }, dimensions)
    if (
      attempts.size !== 3 ||
      attempts.get('/transient.ktx2') !== 6 ||
      attempts.get('/terminal.ktx2') !== 7 ||
      attempts.get('/control.ktx2') !== 1
    ) {
      throw new Error(`Unexpected HTTP attempts: ${JSON.stringify(Object.fromEntries(attempts))}`)
    }
    if (errors.length > 0) {
      throw new Error(errors.join('\n'))
    }
    console.log(JSON.stringify({ ...result, attempts: Object.fromEntries(attempts) }))
  } finally {
    await browser.close()
  }
} finally {
  await server.stop(true)
}
