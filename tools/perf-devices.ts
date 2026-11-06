/** `perf-suite --devices`: which quality tier each Apple form factor starts at. */
import type { Browser, Page } from 'playwright'

interface Snap {
  tier: string
  dpr: number
}

const snap = (page: Page): Promise<Snap | null> =>
  page.evaluate(() => {
    const f = Reflect.get(globalThis, '__owPerf') as (() => Snap) | undefined
    return f ? f() : null
  })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface DeviceProfile {
  name: string
  ua: string
  w: number
  h: number
  dpr: number
  touch: boolean
}
const IOS = 'CPU OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1'
const DEVICES: DeviceProfile[] = [
  {
    name: 'iPhone 13 mini',
    ua: `Mozilla/5.0 (iPhone; ${IOS} Mobile/15E148 Safari/604.1`,
    w: 375,
    h: 812,
    dpr: 3,
    touch: true,
  },
  {
    name: 'iPhone Duo, folded',
    ua: `Mozilla/5.0 (iPhone; ${IOS} Mobile/15E148 Safari/604.1`,
    w: 466,
    h: 678,
    dpr: 3,
    touch: true,
  },
  {
    name: 'iPhone Duo, open',
    ua: `Mozilla/5.0 (iPhone; ${IOS} Mobile/15E148 Safari/604.1`,
    w: 951,
    h: 669,
    dpr: 3,
    touch: true,
  },
  {
    name: 'iPad mini',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Safari/605.1.15',
    w: 744,
    h: 1133,
    dpr: 2,
    touch: true,
  },
  {
    name: 'iPad Pro 13"',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Safari/605.1.15',
    w: 1376,
    h: 1032,
    dpr: 2,
    touch: true,
  },
  {
    name: 'Desktop',
    ua: '',
    w: 1440,
    h: 900,
    dpr: 1,
    touch: false,
  },
]

/**
 * `--devices`: the tier each emulated Apple device starts at (the form-factor prior, before the
 * benchmark) and where the benchmark leaves it. The benchmark runs on this machine's GPU, so its
 * column says what a desktop GPU would get; the prior column is the one to check.
 */
export async function deviceTiers(browser: Browser, game: string): Promise<void> {
  const out: string[][] = []
  for (const d of DEVICES) {
    const ctx = await browser.newContext({ hasTouch: d.touch })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: d.w,
      height: d.h,
      screenWidth: d.w,
      screenHeight: d.h,
      deviceScaleFactor: d.dpr,
      mobile: d.touch,
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: d.touch, maxTouchPoints: 5 })
    if (d.ua) {
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.ua })
    }
    await page.goto(`${game}#perf`)
    await page.waitForFunction(
      () => typeof Reflect.get(globalThis, '__owPerf') === 'function',
      null,
      {
        timeout: 180_000,
      },
    )
    const first = await snap(page)
    const form = await page.evaluate(() => document.documentElement.dataset.owForm ?? '?')
    await sleep(6000)
    const later = await snap(page)
    out.push([
      d.name,
      `${d.w}×${d.h}@${d.dpr}`,
      form,
      first?.tier ?? '?',
      later?.tier ?? '?',
      later?.dpr.toFixed(2) ?? '?',
    ])
    await ctx.close()
  }
  console.log('| device | viewport | form | prior tier | after benchmark (this GPU) | DPR |')
  console.log('|:--|--:|:--|:--|:--|--:|')
  for (const r of out) {
    console.log(`| ${r.join(' | ')} |`)
  }
}
