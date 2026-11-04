// biome-ignore-all lint/security/noSecrets: the lineup's URL fragments, not secrets
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: one page, one step at a time, on purpose
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear walk through the shots
/**
 * The guns, photographed close up: each one in first person (hip and on the sights) and held in
 * third person in Frontier, a rifle and a coach gun pickup turning over their rings, and the
 * duel's rooftop rifleman (the `#lineup` close-up, and the underboss's standoff). Real Chrome
 * against a dev server; the Frontier camera and the hands are driven through the dev hooks.
 *
 *   bun --bun astro dev --port 4401 --ignore-lock
 *   bun tools/gun-shots.ts [baseUrl] [--tag=after] [--only=fps,tps,pickups,rifleman]
 *
 * Writes `.playwright-mcp/guns-<tag>-<shot>.png`. Exit code 1 if a step never got there.
 */
import { mkdirSync } from 'node:fs'
import process from 'node:process'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import { type Browser, chromium, type Page } from 'playwright'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../src/experiments/out-west/contract/town.ts'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4401'
const opt = (k: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const tag = opt('tag') ?? 'after'
const only = new Set((opt('only') ?? 'fps,tps,pickups,rifleman').split(','))
const OUT = '.playwright-mcp'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let failures = 0

interface State {
  x: number
  z: number
  alive: boolean
  draws: number
  tris: number
}

const state = (page: Page): Promise<State> =>
  page.evaluate(() => (Reflect.get(globalThis, '__frontier') as () => State)())

const hook = (page: Page, root: string, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([r, f, a]) => {
      const p = Reflect.get(globalThis, r as string) as Record<string, (...x: unknown[]) => unknown>
      return p[f as string]?.(...(a as unknown[]))
    },
    [root, fn, args] as const,
  )
const pilot = (page: Page, fn: string, ...args: unknown[]) =>
  hook(page, '__frontierPilot', fn, ...args)
const view = (page: Page, fn: string, ...args: unknown[]) =>
  hook(page, '__frontierView', fn, ...args)

async function shot(
  page: Page,
  name: string,
  clip?: [number, number, number, number],
): Promise<void> {
  const path = `${OUT}/guns-${tag}-${name}.png`
  await page.screenshot(
    clip ? { path, clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } } : { path },
  )
  console.log(`  ${path}`)
}

async function openTown(chrome: Browser): Promise<Page> {
  const ctx = await chrome.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`))
  await page.goto(`${base}/experiments/out-west/frontier/?bots=0&debug=1&name=Guns`)
  await page.waitForFunction(
    () => typeof Reflect.get(globalThis, '__frontier') === 'function',
    null,
    {
      timeout: 120_000,
    },
  )
  await page.waitForFunction(() => !document.querySelector('.fr-load'), null, { timeout: 120_000 })
  const t0 = Date.now()
  while (!(await state(page)).alive && Date.now() - t0 < 30_000) {
    await sleep(200)
  }
  await view(page, 'closeHowTo')
  return page
}

const GUNS = [
  [null, 'revolver'],
  [WEAPON_RIFLE, 'rifle'],
  [WEAPON_SHOTGUN, 'shotgun'],
] as const

async function firstPerson(page: Page): Promise<void> {
  await view(page, 'set', 'first')
  // look a little down the street so the gun reads against the dirt and the fronts
  await pilot(page, 'aimPoint', TOWN.size / 2, TOWN.size / 2)
  await sleep(400)
  await pilot(page, 'release')
  for (const [w, name] of GUNS) {
    await view(page, 'weapon', w)
    await view(page, 'ads', false)
    await sleep(1400)
    await shot(page, `fps-${name}-hip`)
    await shot(page, `fps-${name}-hip-close`, [620, 380, 820, 520])
    await view(page, 'ads', true)
    await sleep(900)
    await shot(page, `fps-${name}-ads`)
  }
  await view(page, 'ads', false)
  await view(page, 'weapon', null)
}

async function thirdPerson(page: Page): Promise<void> {
  await view(page, 'set', 'third')
  for (const [w, name] of GUNS) {
    await view(page, 'weapon', w)
    await view(page, 'ads', false)
    await sleep(1200)
    await shot(page, `tps-${name}`)
    await shot(page, `tps-${name}-close`, [380, 360, 520, 420])
    await view(page, 'ads', true)
    await sleep(900)
    await shot(page, `tps-${name}-ads-close`, [380, 360, 520, 420])
  }
  await view(page, 'ads', false)
  await view(page, 'weapon', null)
}

/** Walk up to a rifle pickup and a coach gun pickup and look at each one turning on its ring. */
async function pickups(page: Page): Promise<void> {
  await view(page, 'set', 'third')
  for (const kind of ['rifle', 'shotgun'] as const) {
    const spot = TOWN.pickups.find((p) => p.kind === kind)
    if (!spot) {
      continue
    }
    const s = await state(page)
    const d = Math.hypot(spot.x - s.x, spot.z - s.z)
    const k = Math.max(0, (d - 2.6) / d)
    const gx = s.x + (spot.x - s.x) * k
    const gz = s.z + (spot.z - s.z) * k
    await pilot(page, 'go', gx, gz)
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000) {
      const n = await state(page)
      if (Math.hypot(n.x - gx, n.z - gz) < 0.6) {
        break
      }
      await pilot(page, 'aimPoint', gx, gz)
      await sleep(300)
    }
    await pilot(page, 'stop')
    await pilot(page, 'aimPoint', spot.x, spot.z)
    await sleep(900)
    await pilot(page, 'release')
    await shot(page, `pickup-${kind}`)
    await sleep(500)
    await shot(page, `pickup-${kind}-b`)
  }
}

/** The duel lineup's rifleman, close up from several sides, with the carbine and the coach gun. */
async function rifleman(chrome: Browser): Promise<void> {
  const views = [
    ['left', 'dist=1.7&yaw=1.35'],
    ['left-front', 'dist=1.6&yaw=0.6'],
    ['right-front', 'dist=1.3&yaw=-0.45'],
  ] as const
  for (const gun of ['rifle', 'shotgun'] as const) {
    for (const [side, cam] of views) {
      const ctx = await chrome.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.log(`  page error: ${e.message}`))
      const long = gun === 'shotgun' ? '&long=shotgun' : ''
      await page.goto(`${base}/experiments/out-west/#debug&lineup&aim&focus=17&${cam}${long}`)
      const ok = await page
        .waitForFunction(() => Reflect.get(globalThis, '__ow') !== undefined, null, {
          timeout: 120_000,
        })
        .then(() => true)
        .catch(() => false)
      if (!ok) {
        console.log('  ✗ the duel never loaded')
        failures++
        await ctx.close()
        return
      }
      await sleep(5000)
      await shot(page, `held-${gun}-${side}`)
      await ctx.close()
    }
  }
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
})
if (only.has('fps') || only.has('tps') || only.has('pickups')) {
  const page = await openTown(browser)
  if (only.has('fps')) {
    await firstPerson(page)
  }
  if (only.has('tps')) {
    await thirdPerson(page)
  }
  if (only.has('pickups')) {
    await pickups(page)
  }
  const s = await state(page)
  console.log(`  draws ${s.draws}, tris ${Math.round(s.tris / 1000)}k`)
  await page.context().close()
}
if (only.has('rifleman')) {
  await rifleman(browser)
}
await browser.close()
process.exit(failures > 0 ? 1 : 0)
