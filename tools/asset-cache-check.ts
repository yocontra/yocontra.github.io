/** Exercise the deployed ow-v1 cache on the first new-page load, with a newer SW still waiting. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const out = '.playwright-mcp/quality/asset-cache'
const source = readFileSync('public/experiments/out-west/sw.js', 'utf8')
const VERSION = /const VERSION = '[^']+'/u
const oldWorker = source.replace(VERSION, "const VERSION = 'ow-v1'")
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
// Downloaded deployed ow-v1; its fetch behavior matches the current worker apart from VERSION.
const oldHash = '2bbe3e352c4cd9976e5eaef6eabdef822776da53e7b5f89ad80d0e68ffe67634'
if (hash(oldWorker) !== oldHash) {
  throw new Error('Historical ow-v1 fixture changed; verify against the deployed legacy worker')
}
const helperSource = readFileSync('src/experiments/out-west/platform/asset-url.ts', 'utf8')
const helper = new Bun.Transpiler({ loader: 'ts' }).transformSync(helperSource)
const urls = [
  '/experiments/out-west/3d/models/casual.glb',
  '/experiments/out-west/3d/tex/char_diff.webp',
  '/experiments/out-west/thumbs/outfit.trail-duds.webp',
]
const revision = 'current-release-sha'
const requests = new Map<string, number>()
let newer = false
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/sw.js')) {
      return new Response(newer ? source : oldWorker, {
        headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' },
      })
    }
    if (url.pathname === '/client.js') {
      return new Response(helper, { headers: { 'Content-Type': 'text/javascript' } })
    }
    if (urls.includes(url.pathname)) {
      const key = `${url.pathname}${url.search}`
      requests.set(key, (requests.get(key) ?? 0) + 1)
      return new Response(`current-generation:${url.pathname}`)
    }
    return new Response(
      '<!doctype html><script type="module">import {assetUrl} from "/client.js"; globalThis.assetUrl=assetUrl</script>',
      {
        headers: { 'Content-Type': 'text/html' },
      },
    )
  },
})
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  const legacy = await context.newPage()
  const url = new URL('/experiments/out-west/', server.url).href
  await legacy.goto(url)
  await legacy.evaluate(async () => {
    await navigator.serviceWorker.register('/experiments/out-west/sw.js')
    await navigator.serviceWorker.ready
  })
  await legacy.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  await legacy.evaluate(async (resources) => {
    const cache = await caches.open('out-west-ow-v1')
    await Promise.all(
      resources.map((resource) => cache.put(resource, new Response(`old-generation:${resource}`))),
    )
  }, urls)
  newer = true
  await legacy.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    await registration?.update()
  })
  await legacy.waitForFunction(async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  )
  const current = await context.newPage()
  await current.goto(`${url}?new-page=1`)
  await current.waitForFunction(() => typeof Reflect.get(globalThis, 'assetUrl') === 'function')
  const result = await current.evaluate(
    async ({ resources, buildRevision }) => {
      const revise = Reflect.get(globalThis, 'assetUrl') as (
        resource: string,
        revision: string,
      ) => string
      const cache = await caches.open('out-west-ow-v1')
      const rows = await Promise.all(
        resources.map(async (resource) => {
          const revised = revise(resource, buildRevision)
          return {
            resource,
            revised,
            oldContent: await (await cache.match(resource))?.text(),
            revisedWasCached: Boolean(await cache.match(revised)),
            content: await (await fetch(revised)).text(),
          }
        }),
      )
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        newerWorkerWaiting: Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
        rows,
      }
    },
    { resources: urls, buildRevision: revision },
  )
  const legacyStillOpen = await legacy.evaluate(() => Boolean(navigator.serviceWorker.controller))
  for (const row of result.rows) {
    if (
      row.oldContent !== `old-generation:${row.resource}` ||
      row.revisedWasCached ||
      row.content !== `current-generation:${row.resource}` ||
      requests.get(row.revised) !== 1
    ) {
      throw new Error(`First-load cache mismatch: ${JSON.stringify(row)}`)
    }
  }
  if (!(result.controlled && result.newerWorkerWaiting && legacyStillOpen)) {
    throw new Error('The proof must retain the old controller and the untouched legacy tab')
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'proof.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), oldWorkerSHA256: oldHash, helperSHA256: hash(helperSource), revision, legacyStillOpen, ...result }, null, 2)}\n`,
  )
  console.log(
    `Old ow-v1 first-load proof: ${result.rows.length} revised assets fetched fresh; new SW waiting; legacy tab untouched`,
  )
  await context.close()
} finally {
  await browser.close()
  await server.stop(true)
}
