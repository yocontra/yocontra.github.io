/** Real failed GLB requests during a live native town: bounded retries, visible fallback, recovery, disposal. */
import { chromium } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.setDefaultTimeout(45_000)
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
  const notice = page
    .locator('.pc-game-status')
    .filter({ hasText: 'Some riders are still loading.' })
  await notice.evaluate((element) => {
    const watch = new MutationObserver((records) => {
      Reflect.set(
        element,
        'hiddenWrites',
        Number(Reflect.get(element, 'hiddenWrites')) + records.length,
      )
    })
    Reflect.set(element, 'hiddenWrites', 0)
    watch.observe(element, { attributes: true, attributeFilter: ['hidden'] })
  })
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
  const hiddenWrites = await notice.evaluate((element) => Reflect.get(element, 'hiddenWrites'))
  if (hiddenWrites !== 2 || (await notice.isVisible())) {
    throw new Error(
      `Rider notice did not exactly follow failure and recovery: ${hiddenWrites} writes`,
    )
  }
  await page.screenshot({ path: '/tmp/out-west-client-evidence/native-actor-recovered.png' })
  // The town's seated actors already load outlaw 2. Use the next slot for the late HTTP response.
  if ((await add()) !== 2) {
    throw new Error('Unexpected second late rider slot')
  }
  await page.waitForFunction(() => {
    const actors = (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors
    return actors.loaded === 3 && actors.fallbacks === 0 && actors.loading === 0
  })
  const delayedActor = '**/baked/outlaw-3.glb?*'
  await page.route(delayedActor, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.continue().catch(() => undefined)
  })
  const [, lateId] = await Promise.all([
    page.waitForRequest(delayedActor, { timeout: 15_000 }),
    add(),
  ])
  if (lateId !== 3) {
    throw new Error(`Unexpected third late rider slot: ${lateId}`)
  }
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
  await page.unroute(delayedActor)
  // Shared/dye/Basis decode cancellation uses the real KTX path in test-playcanvas-character-lifecycle.ts.
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    JSON.stringify({ requests, failed, recovered, hiddenWrites, disposed, errors }, null, 2),
  )
} finally {
  await browser.close()
}
