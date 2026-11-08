/** Real failed GLB requests during a live native town: bounded retries, visible fallback, recovery, disposal. */
import { chromium } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
let requests = 0
await page.route('**/baked/outlaw-1.glb?*', (route) => {
  requests++
  return route.abort('failed')
})
const add = () =>
  page.evaluate(async (modulePath) => {
    const { addPlayer } = await import(modulePath)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const id = addPlayer(session.world, {
      accountId: 'late-actor',
      name: 'Arriving rider',
      level: 1,
      prestige: 0,
      bot: true,
    }) as number
    const self = session.world.players[session.selfSlot]
    const player = session.world.players[id]
    if (self && player) {
      Object.assign(player, { x: self.x + 3, z: self.z, lingerUntil: session.world.tick + 10_000 })
    }
    return id
  }, '/src/experiments/out-west/ffa/sim/world.ts')
const stats = () =>
  page.evaluate(
    () => (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors,
  )
try {
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')),
    undefined,
    { timeout: 90_000 },
  )
  await page.addStyleTag({ content: 'astro-dev-toolbar { display: none !important; }' })
  if ((await add()) !== 1) {
    throw new Error('Unexpected late rider slot')
  }
  await page.waitForFunction(
    () =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors.failed === 1,
  )
  await page.waitForFunction(() => {
    const actors = (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors
    return actors.fallbacks === 1 && actors.loaded === 2 && actors.visible === 2
  })
  // PlayCanvas performs five bounded HTTP retries. Observe beyond exhaustion to prove no outer retry loop.
  await new Promise((resolve) => setTimeout(resolve, 6500))
  const failed = await stats()
  if (requests !== 6 || failed.failed !== 1 || failed.fallbacks !== 1 || failed.loaded !== 2) {
    throw new Error(`Unbounded/invisible failure: ${JSON.stringify({ requests, failed })}`)
  }
  await page.screenshot({ path: '/tmp/out-west-client-evidence/native-actor-fallback.png' })
  await page.unroute('**/baked/outlaw-1.glb?*')
  await page.getByRole('button', { name: 'Retry loading riders', exact: true }).click()
  await page.waitForFunction(() => {
    const actors = (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors
    return (
      actors.failed === 0 && actors.fallbacks === 0 && actors.loaded === 2 && actors.loading === 0
    )
  })
  const recovered = await stats()
  await page.screenshot({ path: '/tmp/out-west-client-evidence/native-actor-recovered.png' })
  let loading: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    loading = resolve
  })
  await page.route('**/baked/outlaw-2.glb?*', async (route) => {
    loading?.()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.continue().catch(() => undefined)
  })
  await add()
  await pending
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).destroy(),
  )
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const disposed = await stats()
  if (
    disposed.loaded ||
    disposed.loading ||
    disposed.failed ||
    disposed.visible ||
    (await page.locator('.pc-game-canvas').count())
  ) {
    throw new Error('Late load retained a disposed native actor')
  }
  await page.unroute('**/baked/outlaw-2.glb?*')
  await page.addInitScript(() => {
    const original = globalThis.createImageBitmap
    const waiting: (() => void)[] = []
    Reflect.set(globalThis, '__pauseNativeImages', false)
    Reflect.set(globalThis, '__blockedNativeImages', 0)
    Reflect.set(globalThis, '__releaseNativeImages', () => {
      Reflect.set(globalThis, '__pauseNativeImages', false)
      for (const decode of waiting.splice(0)) {
        decode()
      }
    })
    Reflect.set(globalThis, 'createImageBitmap', (...arguments_: unknown[]) => {
      const decode = () => Reflect.apply(original, globalThis, arguments_) as Promise<ImageBitmap>
      if (!Reflect.get(globalThis, '__pauseNativeImages')) {
        return decode()
      }
      Reflect.set(
        globalThis,
        '__blockedNativeImages',
        Number(Reflect.get(globalThis, '__blockedNativeImages')) + 1,
      )
      return new Promise<ImageBitmap>((resolve, reject) =>
        waiting.push(() => {
          void decode().then(resolve, reject)
        }),
      )
    })
  })
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')),
    undefined,
    { timeout: 90_000 },
  )
  await page.evaluate(() => Reflect.set(globalThis, '__pauseNativeImages', true))
  await add()
  await page.waitForFunction(() => Number(Reflect.get(globalThis, '__blockedNativeImages')) > 0)
  await page.evaluate(() => {
    ;(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).destroy()
    Reflect.get(globalThis, '__releaseNativeImages')()
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const decodedAfterDisposal = await stats()
  if (decodedAfterDisposal.loaded || decodedAfterDisposal.loading || decodedAfterDisposal.visible) {
    throw new Error('Late image decode retained a disposed actor')
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    JSON.stringify(
      { requests, failed, recovered, disposed, decodedAfterDisposal, errors },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
