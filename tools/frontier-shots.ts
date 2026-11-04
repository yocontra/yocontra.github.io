// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: one page, one step at a time, on purpose
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear walk through the shots
/**
 * Frontier shooter views, photographed: the over-the-shoulder and first-person cameras at desktop,
 * phone landscape and phone portrait, the How to play steps, the bank guide on and off screen, the
 * bank prompt and the death-with-money coach line. Loopback town, dev server, real Chrome. The
 * camera is driven through the dev-only `__frontierView` hook (headless can't take the pointer
 * lock) and the rider through the dev autopilot (`?debug`).
 *
 *   bun --bun astro dev --port 4375
 *   bun tools/frontier-shots.ts [baseUrl] [--size=1440x900,812x375,375x812] [--only=howto,tps,fps,bank,death]
 *
 * Writes `.playwright-mcp/tps-<size>-<shot>.png`. Exit code 1 if a step never got there.
 */
import { mkdirSync } from 'node:fs'
import process from 'node:process'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import { type Browser, chromium, type Page } from 'playwright'
import { BOX_WAITING, BTN_FIRE, BTN_INTERACT } from '../src/experiments/out-west/contract/town.ts'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4375'
const opt = (k: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const sizes = (opt('size') ?? '1440x900,812x375,375x812').split(',')
const only = new Set((opt('only') ?? 'howto,tps,fps,bank,death').split(','))
const OUT = '.playwright-mcp'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let failures = 0

interface Other {
  id: number
  x: number
  z: number
  alive: boolean
}
interface State {
  x: number
  z: number
  alive: boolean
  carried: number
  others: Other[]
  bags: { x: number; z: number; amount: number }[]
  strongbox: { spot: number; state: number; value: number } | null
  howto: boolean
  view: string
  yaw: number
  aimTarget: number
  guide: { shown: boolean; onScreen: boolean; metres: number } | null
  draws: number
  tris: number
  textures: number
}

const state = (page: Page): Promise<State> =>
  page.evaluate(() => (Reflect.get(globalThis, '__frontier') as () => State)())

const pilot = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const p = Reflect.get(globalThis, '__frontierPilot') as Record<
        string,
        (...x: unknown[]) => unknown
      >
      return p[f as string]?.(...(a as unknown[]))
    },
    [fn, args] as const,
  )

const view = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const v = Reflect.get(globalThis, '__frontierView') as Record<
        string,
        (...x: unknown[]) => unknown
      >
      return v[f as string]?.(...(a as unknown[]))
    },
    [fn, args] as const,
  )

async function shot(page: Page, size: string, name: string): Promise<void> {
  const path = `${OUT}/tps-${size}-${name}.png`
  await page.screenshot({ path })
  console.log(`  ${path}`)
}

async function until(
  page: Page,
  what: string,
  ok: (s: State) => boolean,
  ms = 20_000,
): Promise<State | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await state(page)
    if (ok(s)) {
      return s
    }
    await sleep(150)
  }
  console.log(`  ✗ never: ${what}`)
  failures++
  return null
}

function nearest(s: State): Other | null {
  let best: Other | null = null
  let bd = Number.POSITIVE_INFINITY
  for (const o of s.others) {
    const d = Math.hypot(o.x - s.x, o.z - s.z)
    if (o.alive && d < bd) {
      bd = d
      best = o
    }
  }
  return best
}

/** Walk at the nearest rider, aim at him and fire until a hit marker shows; photograph it. */
async function hitShot(page: Page, size: string, name: string): Promise<boolean> {
  for (let tries = 0; tries < 60; tries++) {
    const s = await state(page)
    const o = nearest(s)
    if (!(o && s.alive)) {
      await sleep(300)
      continue
    }
    await pilot(page, 'aimAt', o.id)
    const d = Math.hypot(o.x - s.x, o.z - s.z)
    if (d > 9) {
      await pilot(page, 'go', o.x, o.z)
      await sleep(400)
      continue
    }
    await pilot(page, 'stop')
    await sleep(120)
    await pilot(page, 'tap', BTN_FIRE)
    const hit = await page
      .waitForFunction(() => document.querySelector('.fr-hitmark.on') !== null, undefined, {
        timeout: 700,
        polling: 'raf',
      })
      .then(() => true)
      .catch(() => false)
    if (hit) {
      await shot(page, size, name)
      return true
    }
    await sleep(250)
  }
  console.log(`  ✗ never landed a hit for ${name}`)
  failures++
  return false
}

/**
 * Get some money in your carry. Bots pay no kill bounty, so it's the strongbox (the first one
 * spawns a minute in) or a bag someone dropped.
 */
async function earn(page: Page): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < 240_000) {
    const s = await state(page)
    if (s.carried > 0) {
      return true
    }
    const box = s.strongbox?.state === BOX_WAITING ? TOWN.strongboxes[s.strongbox.spot] : undefined
    if (box && s.alive) {
      if (Math.hypot(box.x - s.x, box.z - s.z) > 1.2) {
        await pilot(page, 'aimPoint', box.x, box.z)
        await pilot(page, 'go', box.x, box.z)
        await sleep(500)
      } else {
        await pilot(page, 'stop')
        await pilot(page, 'tap', BTN_INTERACT)
        await sleep(3600)
      }
      continue
    }
    // a bag in the dirt is the quickest money in town
    const bag = s.bags.find((b) => Math.hypot(b.x - s.x, b.z - s.z) < 30)
    if (bag && s.alive) {
      await pilot(page, 'aimPoint', bag.x, bag.z)
      await pilot(page, 'go', bag.x, bag.z)
      await sleep(400)
      continue
    }
    // nothing to take yet: wait where you are
    await pilot(page, 'stop')
    await sleep(500)
  }
  return false
}

async function openTown(chrome: Browser, size: string, extra = ''): Promise<Page> {
  const [w, h] = size.split('x').map(Number)
  const touch = (w ?? 0) < 1000
  const ctx = await chrome.newContext({
    viewport: { width: w ?? 1440, height: h ?? 900 },
    deviceScaleFactor: touch ? 2 : 1,
    isMobile: touch,
    hasTouch: touch,
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`))
  await page.goto(`${base}/experiments/out-west/frontier/?bots=12&debug=1&name=Shots${extra}`)
  await page.waitForFunction(
    () => typeof Reflect.get(globalThis, '__frontier') === 'function',
    null,
    {
      timeout: 120_000,
    },
  )
  await page.waitForFunction(() => !document.querySelector('.fr-load'), null, { timeout: 120_000 })
  await until(page, 'alive', (s) => s.alive, 30_000)
  return page
}

async function howto(page: Page, size: string): Promise<void> {
  await until(page, 'How to play open', (s) => s.howto, 8000)
  for (let i = 1; i <= 4; i++) {
    await sleep(350)
    await shot(page, size, `howto-${i}`)
    await page.locator('.fr-howto .fr-howto-row .fr-menu-item').last().click()
  }
  await until(page, 'How to play closed', (s) => !s.howto, 4000)
}

async function views(page: Page, size: string, v: 'third' | 'first'): Promise<void> {
  const tag = v === 'third' ? 'tps' : 'fps'
  await view(page, 'set', v)
  await view(page, 'ads', false)
  await sleep(600)
  await shot(page, size, `${tag}-spawn`)
  // walk across the street, the camera following
  const s = await state(page)
  await pilot(page, 'aimPoint', TOWN.size / 2, TOWN.size / 2 + 6)
  await pilot(page, 'go', TOWN.size / 2, TOWN.size / 2 + 6)
  await sleep(900)
  await shot(page, size, `${tag}-walk`)
  await pilot(page, 'stop')
  void s
  await view(page, 'ads', true)
  await sleep(500)
  await shot(page, size, `${tag}-ads`)
  await view(page, 'ads', false)
  await hitShot(page, size, `${tag}-hit`)
  await pilot(page, 'release')
}

async function bank(page: Page, size: string): Promise<void> {
  await view(page, 'set', 'third')
  // a kill pays a bounty into your carry
  if (!(await earn(page))) {
    console.log('  ✗ never earned a carry')
    failures++
    return
  }
  await pilot(page, 'release')
  await sleep(300)
  await shot(page, size, 'carry-coach')
  // face the bank, then away from it
  const w = TOWN.zones.find((z) => z.kind === 'bank')
  if (!w) {
    return
  }
  const cur = await state(page)
  await pilot(page, 'aimPoint', w.x, w.z)
  await sleep(500)
  await pilot(page, 'release')
  await shot(page, size, 'bank-onscreen')
  await pilot(page, 'aimPoint', cur.x * 2 - w.x, cur.z * 2 - w.z)
  await sleep(500)
  await pilot(page, 'release')
  await until(page, 'guide off screen', (x) => x.guide?.shown === true && !x.guide.onScreen, 3000)
  await shot(page, size, 'bank-offscreen')
  // walk to the window: the prompt
  await pilot(page, 'go', w.x, w.z)
  await pilot(page, 'aimPoint', w.x, w.z - 6)
  await until(page, 'at the window', (x) => Math.hypot(x.x - w.x, x.z - w.z) < w.r - 0.1, 60_000)
  await pilot(page, 'stop')
  await sleep(600)
  await shot(page, size, 'bank-prompt')
  await pilot(page, 'tap', BTN_INTERACT)
  await until(page, 'banked', (x) => x.carried === 0, 8000)
  await sleep(400)
  await shot(page, size, 'banked-coach')
  await pilot(page, 'release')
}

async function deathWithMoney(page: Page, size: string): Promise<void> {
  // earn a carry, then stand in the open until someone takes it from you
  if (!(await earn(page))) {
    console.log('  ✗ never earned a second carry')
    failures++
    return
  }
  await pilot(page, 'release')
  const died = await page
    .waitForFunction(
      () => {
        const f = (Reflect.get(globalThis, '__frontier') as () => { alive: boolean })()
        return !f.alive
      },
      undefined,
      { timeout: 150_000, polling: 500 },
    )
    .then(() => true)
    .catch(() => false)
  if (!died) {
    console.log('  ✗ nobody shot us in 150 s')
    failures++
    return
  }
  await sleep(500)
  await shot(page, size, 'death-money')
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
})
for (const size of sizes) {
  console.log(size)
  const page = await openTown(browser, size)
  if (only.has('howto')) {
    await howto(page, size)
  } else {
    await view(page, 'closeHowTo')
  }
  if (only.has('tps')) {
    await views(page, size, 'third')
  }
  if (only.has('fps')) {
    await views(page, size, 'first')
  }
  if (only.has('bank')) {
    // the bots circle and spare you (`?cluster`): earn a bounty in peace, then walk it to the bank
    const calm = await openTown(browser, size, '&cluster')
    await view(calm, 'closeHowTo')
    await bank(calm, size)
    await calm.context().close()
  }
  if (only.has('death')) {
    await deathWithMoney(page, size)
  }
  const s = await state(page)
  console.log(`  draws ${s.draws}, tris ${Math.round(s.tris / 1000)}k, textures ${s.textures}`)
  await page.context().close()
}
await browser.close()
process.exit(failures > 0 ? 1 : 0)
