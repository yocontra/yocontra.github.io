/** Desktop active-town soak; it does not certify iPhone GPU performance or thermals. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const duration = Number(process.env.OW_SOAK_SECONDS ?? 900)
const directory = '/tmp/out-west-native-soak'
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message.split('?')[0] ?? 'Page error'))
// Freeze only Vite's HMR socket; gameplay remains on the real native production mount.
await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
const samples: unknown[] = []
try {
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=31&cluster&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')),
    undefined,
    { timeout: 90_000 },
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.mouse.click(640, 360)
  await page.keyboard.down('KeyW')
  await page.screenshot({ path: `${directory}/start.png` })
  const start = Date.now()
  const startTick = await page.evaluate(
    () => Reflect.get(globalThis, '__nativeFrontierSession').world.tick as number,
  )
  let latestTick = startTick
  let count = 0
  while ((latestTick - startTick) / 20 < duration) {
    const again = page.getByRole('button', { name: 'Ride again', exact: true })
    if (await again.isVisible()) {
      await again.click()
      await page.keyboard.up('KeyW')
      await page.keyboard.down('KeyW')
    }
    // Native controls remain active during the whole measured window, including first shots.
    await page.evaluate(() => {
      const game = Reflect.get(globalThis, '__playcanvasFrontier')
      game.tap(1)
      game.tap(8)
      const session = Reflect.get(globalThis, '__nativeFrontierSession')
      const candidates = session.world.players
        .filter((player: { bot: boolean; alive: boolean } | null) => player?.bot && player.alive)
        .slice(0, 4)
      for (const player of candidates) {
        player.alive = false
        player.hp = 0
        player.respawnTick = session.world.tick + 30
      }
    })
    await page.mouse.move(count % 2 ? 500 : 780, 360, { steps: 4 })
    const metrics = await cdp.send('Performance.getMetrics')
    const sample = await page.evaluate(() => ({
      ...Reflect.get(globalThis, '__playcanvasFrontier').debug(),
      tick: Reflect.get(globalThis, '__nativeFrontierSession').world.tick,
    }))
    if (sample.players !== 32 || sample.ragdolls.active > 4 || sample.ragdolls.bodies > 40) {
      throw new Error('Native population/body bound changed')
    }
    const memory = Object.fromEntries(
      metrics.metrics
        .filter((metric) =>
          ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(metric.name),
        )
        .map((metric) => [metric.name, metric.value]),
    )
    latestTick = sample.tick
    samples.push({
      activeSeconds: (latestTick - startTick) / 20,
      seconds: (Date.now() - start) / 1000,
      ...sample,
      memory,
    })
    await writeFile(
      `${directory}/progress.json`,
      JSON.stringify({ desktopProxy: true, duration, samples, errors }, null, 2),
    )
    console.log(JSON.stringify(samples.at(-1)))
    count++
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  await page.keyboard.up('KeyW')
  await page.screenshot({ path: `${directory}/end.png` })
  const disposed = await page.evaluate(() => {
    const game = Reflect.get(globalThis, '__playcanvasFrontier')
    game.destroy()
    return { ...game.debug(), canvases: document.querySelectorAll('.pc-game-canvas').length }
  })
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify(
      { desktopProxy: true, seconds: (Date.now() - start) / 1000, samples, disposed, errors },
      null,
      2,
    ),
  )
  if (disposed.ragdolls.bodies || disposed.players || disposed.canvases || errors.length > 0) {
    throw new Error('Soak lifecycle/error check failed')
  }
  console.log('Native desktop soak passed; physical iPhone target remains unverified.')
} finally {
  await browser.close()
}
