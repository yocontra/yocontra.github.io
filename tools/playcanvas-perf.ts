/** Repeatable phone-size CPU proxy; this does not certify physical iPhone GPU or thermals. */
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4389'
const option = (name: string, fallback: number) =>
  Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const rate = option('rate', 4)
const seconds = option('seconds', 30)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  await page.goto(
    `${base}/experiments/out-west/frontier/?server=loopback&bots=31&cluster&seed=7&spawn=72,66`,
  )
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')), null, {
    timeout: 90_000,
  })
  const result = await page.evaluate(async (duration) => {
    const game = Reflect.get(globalThis, '__playcanvasFrontier')
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
    const intervals: number[] = []
    const samples: unknown[] = []
    const start = performance.now()
    let previous = start
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        intervals.push(now - previous)
        previous = now
        if (intervals.length % 60 === 0) {
          samples.push(game.debug())
        }
        if (now - start < duration * 1000) {
          requestAnimationFrame(tick)
        } else {
          resolve()
        }
      }
      requestAnimationFrame(tick)
    })
    intervals.sort((a, b) => a - b)
    const percentile = (p: number) => intervals[Math.floor((intervals.length - 1) * p)] ?? 0
    return {
      frames: intervals.length,
      frameMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      samples,
      final: game.debug(),
    }
  }, seconds)
  const report = {
    date: new Date().toISOString(),
    viewport: { width: 375, height: 812 },
    cpuThrottle: rate,
    seconds,
    physicalDevice: false,
    ...result,
    errors,
  }
  await writeFile('/tmp/out-west-native-performance.json', JSON.stringify(report, null, 2))
  await page.screenshot({ path: '/tmp/out-west-native-performance.png' })
  console.log(JSON.stringify(report, null, 2))
  if (errors.length > 0) {
    throw new Error('Browser errors recorded')
  }
} finally {
  await browser.close()
}
