/** Production renderer CPU diagnosis. Profiler overhead makes this unsuitable for acceptance. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { frameTiming } from './content/frame-timing.ts'
import { prepareProductionFixture } from './content/production-fixture.ts'
import { startProfile, stopProfile } from './perf-lib.ts'

const option = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const origin = option('url', 'http://127.0.0.1:4398')
const api = option('api', 'http://127.0.0.1:8798')
const output = option('out', '/tmp/out-west-production-stress-profile')
const seconds = Number(option('seconds', '30'))
const visible = process.argv.includes('--visible')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: !visible })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 713 } })
  page.on('pageerror', (error) => errors.push(error.message))
  const fixture = await prepareProductionFixture(page, origin, api, true)
  if (visible) {
    await page.bringToFront()
  }
  await page.locator('canvas').first().click()
  await page.screenshot({ path: join(output, 'before.png') })
  const cdp = await page.context().newCDPSession(page)
  await fixture.start()
  await startProfile(cdp)
  await page.evaluate(
    (duration) => Reflect.get(globalThis, '__owFrameRecorder').start(duration),
    seconds,
  )
  let iteration = 0
  while (await page.evaluate(() => Reflect.get(globalThis, '__owFrameRecorder').status().running)) {
    const side = iteration % 2 === 0 ? 'KeyA' : 'KeyD'
    await page.keyboard.down('KeyW')
    await page.keyboard.down(side)
    await page.keyboard.down('ShiftLeft')
    await page.mouse.move(iteration % 2 === 0 ? 560 : 720, 360, { steps: 3 })
    await page.mouse.click(640, 360)
    if (iteration % 6 === 0) {
      await page.keyboard.press('Space')
    }
    if (iteration % 8 === 0) {
      await page.keyboard.press('KeyR')
    }
    if (iteration % 4 === 0) {
      await page.mouse.down({ button: 'right' })
    }
    await Bun.sleep(700)
    await page.mouse.up({ button: 'right' })
    await page.keyboard.up(side)
    await page.keyboard.up('ShiftLeft')
    iteration++
  }
  await page.keyboard.up('KeyW')
  const profile = await stopProfile(cdp, true, 40)
  await writeFile(join(output, 'main.cpuprofile'), JSON.stringify(profile))
  const authority = await fixture.finish()
  const recording = await page.evaluate(() => Reflect.get(globalThis, '__owFrameRecorder').result())
  const history = await page.evaluate(() =>
    Reflect.get(globalThis, '__owPerformanceSnapshot')(true),
  )
  const build = await (await fetch(new URL('/recording-build.json', origin))).json()
  const report = {
    classification: 'diagnostic-production-profile',
    surface: visible ? 'visible-chrome' : 'headless-chrome',
    samplingIntervalMicroseconds: 200,
    overhead:
      'Chrome sampling profiler active throughout; these timings are not acceptance evidence',
    build,
    authority,
    history,
    errors,
    recording,
    timing: frameTiming(recording.timestamps),
  }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(report, null, 2))
  await page.screenshot({ path: join(output, 'after.png') })
  console.log(
    JSON.stringify({ output, fps: report.timing.fps, frameMs: report.timing.frameMs, errors }),
  )
} finally {
  await browser.close()
}
