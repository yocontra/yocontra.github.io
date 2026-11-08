// biome-ignore-all lint/style/useNamingConvention: browser probe names mirror native module exports
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: compatibility mouse suppression has a bounded timing window
/** Native input regressions against the real browser class; a connected physical controller is not required. */
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true })
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.goto(`${origin}/experiments/`, { waitUntil: 'load' })
  const turns = await page.evaluate(async () => {
    const modulePath = '/src/experiments/out-west/client/input.ts'
    const { GameInput } = await import(modulePath)
    const settingsPath = '/src/experiments/out-west/ffa/client/settings.ts'
    const { DEFAULTS } = await import(settingsPath)
    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;z-index:99999;touch-action:none'
    document.body.append(canvas)
    const pad = { connected: true, axes: [0, 0, 1, 0], buttons: [] }
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] })
    const input = new GameInput(canvas, document.body)
    const samples = [30, 60, 120].map((hz) => {
      input.yaw = 0
      for (let i = 0; i < hz; i++) {
        input.sample(i, 1 / hz)
      }
      return { hz, yaw: input.yaw }
    })
    input.configure({ ...DEFAULTS, view: 'top' })
    input.sample(0, 1 / 60)
    const top = { yaw: input.yaw, cursorAim: input.cursorAim }
    if (top.cursorAim || Math.abs(top.yaw + Math.PI / 2) > 1e-9) {
      throw new Error('Top-view right stick did not own its world direction')
    }
    pad.axes[2] = 0
    Reflect.set(globalThis, '__inputReview', { input, canvas })
    return { samples, top }
  })
  for (const sample of turns.samples) {
    if (Math.abs(sample.yaw + 4.5) > 1e-9) {
      throw new Error(`Turn rate depends on refresh rate: ${JSON.stringify(turns)}`)
    }
  }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 900, y: 200 }],
  })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 950, y: 200 }],
  })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const touch = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__inputReview')
    const intent = probe.input.sample(1, 1 / 60)
    const result = { yaw: intent.yaw, cursorAim: probe.input.cursorAim }
    return result
  })
  if (touch.cursorAim || Math.abs(touch.yaw + Math.PI / 2) > 0.01) {
    throw new Error(`Top-view touch aim lost its world direction: ${JSON.stringify(touch)}`)
  }
  await page.mouse.move(1100, 100)
  const compatibilityMouse = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__inputReview')
    probe.input.sample(2, 1 / 60)
    return probe.input.cursorAim
  })
  if (compatibilityMouse) {
    throw new Error('Compatibility mouse movement stole touch aim after release')
  }
  await page.waitForTimeout(550)
  await page.mouse.move(800, 100)
  const mouse = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__inputReview')
    probe.input.sample(3, 1 / 60)
    const cursorAim = probe.input.cursorAim
    probe.input.destroy()
    probe.canvas.remove()
    return cursorAim
  })
  if (!mouse) {
    throw new Error('Neutral connected controller stole active mouse aim')
  }
  console.log(JSON.stringify({ turns, touch, compatibilityMouse, mouse }))
} finally {
  await browser.close()
}
