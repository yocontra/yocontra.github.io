/** Real-browser refusal visibility/actionability through loading, onboarding and pause menus. */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import type { FrontierHandle } from '../src/experiments/out-west/ffa/client/index.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4321'
const out = '.playwright-mcp/quality'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
let assertions = 0
function check(ok: boolean, message: string): void {
  assertions++
  if (!ok) {
    throw new Error(message)
  }
}

interface VersionProbe {
  handle: FrontierHandle | null
  worker: Worker | null
  welcome: string
  loopbacks: number
  terminated: number
}

try {
  const cases = [
    { device: 'desktop', width: 1280, height: 800, touch: false },
    { device: 'phone', width: 375, height: 812, touch: true },
  ].flatMap((device) =>
    (['loading', 'onboarding', 'menu'] as const).map((phase) => ({ ...device, phase })),
  )
  for (const test of cases) {
    const phase = test.phase
    const label = `${test.device}-${phase}`
    const context = await browser.newContext({
      viewport: { width: test.width, height: test.height },
      hasTouch: test.touch,
      isMobile: test.touch,
    })
    await context.routeWebSocket(
      (url) => url.host === new URL(base).host,
      (socket) => socket.send(JSON.stringify({ type: 'connected' })),
    )
    const page = await context.newPage()
    await page.goto(base)
    await page.evaluate(async (early) => {
      const probe: VersionProbe = {
        handle: null,
        worker: null,
        welcome: '',
        loopbacks: 0,
        terminated: 0,
      }
      Reflect.set(globalThis, '__versionProbe', probe)
      const RealWorker = globalThis.Worker
      class WelcomeWorker extends RealWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options)
          if (!String(url).includes('loopback.worker')) {
            return
          }
          probe.worker = this
          probe.loopbacks++
          let replaced = false
          this.addEventListener('message', (event: MessageEvent<unknown>) => {
            if (typeof event.data !== 'string' || replaced) {
              return
            }
            const msg = JSON.parse(event.data) as { type?: string; contractVersion?: number }
            if (msg.type !== 'welcome') {
              return
            }
            probe.welcome = event.data
            if (early) {
              replaced = true
              event.stopImmediatePropagation()
              this.dispatchEvent(
                new MessageEvent('message', {
                  data: JSON.stringify({ ...msg, contractVersion: 9 }),
                }),
              )
            }
          })
        }

        override terminate(): void {
          if (this === probe.worker) {
            probe.terminated++
          }
          super.terminate()
        }
      }
      Reflect.set(globalThis, 'Worker', WelcomeWorker)
      const moduleUrl = '/src/experiments/out-west/ffa/client/index.ts'
      const viewportUrl = '/src/experiments/out-west/platform/viewport.ts'
      const { mountFrontier } = await import(/* @vite-ignore */ moduleUrl)
      const { installViewportVars } = await import(/* @vite-ignore */ viewportUrl)
      installViewportVars()
      const root = document.createElement('div')
      root.id = 'version-test'
      document.body.replaceChildren(root)
      probe.handle = mountFrontier(root, { server: 'loopback', bots: 0, seed: 7 })
    }, phase === 'loading')
    if (phase !== 'loading') {
      await page.evaluate(async () => {
        const probe = Reflect.get(globalThis, '__versionProbe') as VersionProbe
        await probe.handle?.ready
      })
      await page.locator('#version-test > .fr-load').waitFor({ state: 'detached' })
      await page.locator('.fr-howto:not([hidden])').waitFor()
      if (phase === 'menu') {
        await page.getByRole('button', { name: 'Skip', exact: true }).click()
        if (test.touch) {
          await page.locator('.fr-menu-btn').click()
        } else {
          // Leaving onboarding takes pointer lock; Escape releases it and opens the pause menu.
          await page.keyboard.press('Escape')
        }
        await page.locator('.fr-menu.on').waitFor()
      }
      await page.evaluate(() => {
        const probe = Reflect.get(globalThis, '__versionProbe') as VersionProbe
        if (!(probe.worker && probe.welcome)) {
          throw new Error('Loopback never delivered its compatible welcome')
        }
        probe.worker.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ ...JSON.parse(probe.welcome), contractVersion: 9 }),
          }),
        )
      })
    }
    const refusal = page.locator('#version-test .fr-refuse')
    await refusal.waitFor({ timeout: 120_000 })
    await page.evaluate(async () => {
      const probe = Reflect.get(globalThis, '__versionProbe') as VersionProbe
      await probe.handle?.ready
    })
    check(await refusal.isVisible(), `${label}: refusal disappeared after startup settled`)
    check(
      (await refusal.textContent())?.includes('The town is updating.') === true,
      `${label}: missing update notice`,
    )
    check(
      await refusal.getByRole('button', { name: 'Refresh', exact: true }).isVisible(),
      `${label}: missing Refresh action`,
    )
    check(
      await refusal.getByRole('button', { name: 'Refresh', exact: true }).evaluate((button) => {
        const rect = button.getBoundingClientRect()
        return (
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button
        )
      }),
      `${label}: another game overlay covers Refresh`,
    )
    await refusal.getByRole('button', { name: 'Refresh', exact: true }).click({ trial: true })
    check(
      (await refusal.textContent())?.includes("Couldn't reconnect") === false,
      `${label}: generic lost state replaced the notice`,
    )
    await page.waitForFunction(() => {
      const probe = Reflect.get(globalThis, '__versionProbe') as VersionProbe
      return probe.terminated === 1
    })
    check(
      await page.evaluate(
        () => (Reflect.get(globalThis, '__versionProbe') as VersionProbe).loopbacks === 1,
      ),
      `${label}: connection restarted automatically`,
    )
    await page.screenshot({ path: `${out}/frontier-version-${label}.png` })
    await page.evaluate(() => {
      const probe = Reflect.get(globalThis, '__versionProbe') as VersionProbe
      probe.handle?.destroy()
    })
    check(
      (await page.locator('#version-test .fr-load, #version-test canvas').count()) === 0,
      `${label}: destroy left a refusal overlay or canvas`,
    )
    console.log(`${label}: 7 assertions passed + Refresh trial click`)
    await context.close()
  }
  console.log(`Frontier version UI: ${assertions} assertions passed`)
} finally {
  await browser.close()
}
