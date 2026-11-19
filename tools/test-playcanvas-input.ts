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
    const touchControls = document.querySelector('.pc-touch-controls')
    const use = touchControls?.querySelector<HTMLButtonElement>('.pc-use')
    if (!(touchControls && use)) {
      throw new Error('Missing touch context controls')
    }
    const context = { use: false, call: false, throw: false }
    input.setContext(context)
    const attributes = new MutationObserver(() => undefined)
    attributes.observe(touchControls, {
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    for (let i = 0; i < 300; i++) {
      input.setContext(context)
    }
    const unchangedWrites = attributes.takeRecords().length
    input.setContext({ ...context, use: true })
    if (use.hidden) {
      throw new Error('USE did not appear when its context became available')
    }
    input.setContext(context)
    const changedWrites = attributes.takeRecords().length
    attributes.disconnect()
    if (!use.hidden || unchangedWrites !== 0 || changedWrites !== 2) {
      throw new Error(
        `Touch context made ${unchangedWrites} redundant and ${changedWrites} real writes`,
      )
    }
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
    return { samples, top, unchangedWrites, changedWrites }
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
    return cursorAim
  })
  if (!mouse) {
    throw new Error('Neutral connected controller stole active mouse aim')
  }
  await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__inputReview')
    const fire = document.querySelector<HTMLButtonElement>('.pc-fire')
    if (!fire) {
      throw new Error('Missing touch fire button')
    }
    fire.style.cssText =
      'position:fixed;inset:20px auto auto 900px;width:100px;height:100px;display:block;z-index:100000;touch-action:none'
    for (const element of [probe.canvas, fire] as HTMLElement[]) {
      element.addEventListener('pointerdown', (event) => {
        element.dataset.reviewPointer = String(event.pointerId)
      })
    }
  })
  const lostCapture: {
    expected: 'move' | 'fire'
    moveX: number
    moveZ: number
    buttons: number
  }[] = []
  for (const [selector, start, move, expected] of [
    ['canvas[data-review-pointer]', { x: 100, y: 200 }, { x: 150, y: 200 }, 'move'],
    ['.pc-fire[data-review-pointer]', { x: 940, y: 60 }, { x: 950, y: 70 }, 'fire'],
  ] as const) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [move] })
    const active = await page.evaluate(() =>
      Reflect.get(globalThis, '__inputReview').input.sample(4),
    )
    if (expected === 'move') {
      const stick = await page.locator('.pc-movement-hint').evaluate((element: HTMLElement) => ({
        local: Number.parseFloat(element.style.getPropertyValue('--move-x')),
        inheritedFromControls: element.parentElement?.style.getPropertyValue('--move-x') ?? '',
      }))
      if (
        !Number.isFinite(stick.local) ||
        Math.abs(stick.local - active.moveX * 22) > 1e-9 ||
        stick.inheritedFromControls
      ) {
        throw new Error('Movement hint did not follow the same trusted stick input locally')
      }
    }
    if (expected === 'move' ? active.moveX <= 0.5 : active.buttons === 0) {
      throw new Error(`Touch ${expected} was not active before capture loss`)
    }
    await page.locator(selector).evaluate((element: HTMLElement) => {
      const pointerId = Number(element.dataset.reviewPointer)
      if (!element.hasPointerCapture(pointerId)) {
        throw new Error('The browser did not capture the probe touch')
      }
      element.addEventListener(
        'lostpointercapture',
        () => {
          element.dataset.reviewLost = 'yes'
        },
        { once: true },
      )
      element.releasePointerCapture(pointerId)
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 650, y: 400 }],
    })
    await page.locator(`${selector}[data-review-lost]`).waitFor({ state: 'attached' })
    const after = await page.evaluate(async () => {
      const probe = Reflect.get(globalThis, '__inputReview')
      await new Promise((resolve) => setTimeout(resolve, 125))
      return probe.input.sample(5)
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    lostCapture.push({ expected, moveX: after.moveX, moveZ: after.moveZ, buttons: after.buttons })
    if (expected === 'fire' && (await page.locator('.pc-fire.held').count())) {
      throw new Error('Fire button stayed lit after capture loss')
    }
  }
  if (lostCapture.some((state) => state.moveX || state.moveZ || state.buttons)) {
    throw new Error(`Touch input stayed active after capture loss: ${JSON.stringify(lostCapture)}`)
  }
  await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__inputReview')
    probe.input.destroy()
    probe.canvas.remove()
  })
  console.log(JSON.stringify({ turns, touch, compatibilityMouse, mouse, lostCapture }))
} finally {
  await browser.close()
}
