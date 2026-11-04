/**
 * Frontier vault, end to end: the real client against the local Worker's Lobby DO, driven through
 * the dev autopilot, on a desktop viewport and a touch phone. A rider runs at a fence and presses
 * jump (`BTN_JUMP`) inside reach: it must come down on the far side, on the server too, with no
 * reconciliation snap. Then it runs at the saloon's west wall and presses jump: a hop, and the wall
 * still stops it. Saves a few frames of each vault to `.playwright-mcp/vault-*.png`.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8814 --inspector-port 9254 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8814 bun --bun astro dev --port 4374
 *   bun api/test/frontier-vault.ts [--site http://localhost:4374]
 *
 * Not part of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: the rider is polled one step at a time, on purpose
import process from 'node:process'
import { type Browser, chromium, type Page } from 'playwright'
import { BTN_JUMP } from '../../src/experiments/out-west/contract/town.ts'
import { PLAYER_RADIUS } from '../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  buildGrid,
  circleBlocked,
  type Rect,
  TOWN,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { vaultDistance } from '../../src/experiments/out-west/ffa/sim/move.ts'
import type { MoveState } from '../../src/experiments/out-west/ffa/sim/types.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4374')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const grid = buildGrid()
const db = openLocalD1()

interface Pilot {
  go: (x: number, z: number) => boolean
  walking: () => boolean
  stick: (mx: number, mz: number) => void
  tap: (bit: number) => void
  release: () => void
}
interface Corr {
  smooth: number
  snap: number
}
interface State {
  x: number
  z: number
  alive: boolean
}

const move = (x: number, z: number): MoveState => ({
  x,
  z,
  rollTicks: 0,
  rollCooldown: 0,
  rollDirX: 0,
  rollDirZ: 0,
  jumpTicks: 0,
  jumpCooldown: 0,
  vaultStep: 0,
  vaultAim: 0,
  sprinting: false,
  sprintLock: 0,
  sprintOut: 0,
  slideTicks: 0,
  slideCooldown: 0,
  slideAim: 0,
  airX: 0,
  airZ: 0,
})
const free = (x: number, z: number): boolean =>
  !circleBlocked(grid, { x, z, r: PLAYER_RADIUS }, BLOCK_MOVE)

interface Run {
  /** Where to stand (a 2 m run-up), the unit direction to run, and the line to cross. */
  x: number
  z: number
  dx: number
  dz: number
  cover: Rect
}

/** A fence near the middle of town with clear ground 2 m either side of its thin side. */
function fenceRun(): Run {
  const runs: Run[] = []
  for (const c of TOWN.cover.filter((q) => q.kind === 'fence' && q.vaultHeight !== undefined)) {
    const across = c.w < c.d
    const cx = c.x + c.w / 2
    const cz = c.z + c.d / 2
    for (const side of [1, -1]) {
      const off = (across ? c.w : c.d) / 2 + PLAYER_RADIUS + 2
      const x = across ? cx + side * off : cx
      const z = across ? cz : cz + side * off
      const dx = across ? -side : 0
      const dz = across ? 0 : -side
      const near = move(x + dx * 1.6, z + dz * 1.6)
      if (free(x, z) && free(near.x, near.z) && vaultDistance(grid, near, dx, dz) > 0) {
        runs.push({ x, z, dx, dz, cover: c })
      }
    }
  }
  runs.sort((a, b) => Math.hypot(a.x - 72, a.z - 64) - Math.hypot(b.x - 72, b.z - 64))
  const run = runs[0]
  if (!run) {
    throw new Error('no fence to vault in this layout')
  }
  return run
}

async function rider(chrome: Browser, label: string, touch: boolean): Promise<Page> {
  const player = await seedPlayer(db, { name: `Vault ${label}`, purse: 500, clears: 7 })
  const ctx = await chrome.newContext(
    touch
      ? { viewport: { width: 812, height: 375 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1440, height: 900 } },
  )
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`${label} page error:`, e.message))
  const q = new URLSearchParams({ server: 'remote', bots: '0', debug: '1', token: player.token })
  await page.goto(`${SITE}/experiments/out-west/frontier/?${q.toString()}#tier=floor`)
  await page.waitForFunction(
    () => (Reflect.get(globalThis, '__frontier') as () => State)().alive === true,
    null,
    { timeout: 90_000 },
  )
  return page
}

const state = (page: Page): Promise<State> =>
  page.evaluate(() => (Reflect.get(globalThis, '__frontier') as () => State)())
/** Call the dev autopilot (`client/autopilot.ts`) in the page. */
const pilot = (page: Page, method: keyof Pilot, ...args: number[]): Promise<unknown> =>
  page.evaluate(
    ([m, a]) => {
      const p = Reflect.get(globalThis, '__frontierPilot') as Record<
        string,
        (...n: number[]) => unknown
      >
      return p[m as string]?.(...(a as number[]))
    },
    [method, args] as const,
  )

async function walkTo(page: Page, x: number, z: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pilot(page, 'go', x, z)
    for (let i = 0; i < 160; i++) {
      await sleep(400)
      if (!(await pilot(page, 'walking'))) {
        break
      }
    }
    const s = await state(page)
    if (Math.hypot(s.x - x, s.z - z) < 1) {
      return true
    }
  }
  return false
}

/** Run along (dx, dz) from where you stand and press jump once the sim says a vault is in reach. */
async function runAndJump(
  page: Page,
  dx: number,
  dz: number,
  shots: string,
): Promise<{ before: State; after: State; pressed: boolean }> {
  const before = await state(page)
  await pilot(page, 'stick', dx, dz)
  let pressed = false
  for (let i = 0; i < 40 && !pressed; i++) {
    await sleep(30)
    const s = await state(page)
    if (vaultDistance(grid, move(s.x, s.z), dx, dz) > 0 || i === 39) {
      await pilot(page, 'tap', BTN_JUMP)
      pressed = vaultDistance(grid, move(s.x, s.z), dx, dz) > 0
      for (let k = 0; k < 4; k++) {
        await sleep(90)
        await page.screenshot({ path: `${shots}-${k}.png` })
      }
    }
  }
  await sleep(700)
  await pilot(page, 'release')
  await sleep(600)
  return { before, after: await state(page), pressed }
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
})
let code = 0
try {
  console.log('Frontier vault, end to end')
  const run = fenceRun()
  console.log(
    `  fence at (${run.cover.x}, ${run.cover.z}) ${run.cover.w}×${run.cover.d}; run-up from (${run.x}, ${run.z})`,
  )
  for (const touch of [false, true]) {
    const label = touch ? 'touch' : 'desktop'
    const page = await rider(browser, label, touch)
    const corr0 = await page.evaluate(() =>
      (Reflect.get(globalThis, '__frontierTrace') as { corr: () => Corr }).corr(),
    )
    check(`${label}: reaches the fence`, await walkTo(page, run.x, run.z))
    const v = await runAndJump(page, run.dx, run.dz, `.playwright-mcp/vault-${label}`)
    const mid = { x: run.cover.x + run.cover.w / 2, z: run.cover.z + run.cover.d / 2 }
    const side = (p: State): number => (p.x - mid.x) * run.dx + (p.z - mid.z) * run.dz
    check(`${label}: jump pressed within reach`, v.pressed)
    check(`${label}: vaulted the fence (came down on the far side)`, side(v.after) > 0.4, {
      before: v.before,
      after: v.after,
    })
    const corr1 = await page.evaluate(() =>
      (Reflect.get(globalThis, '__frontierTrace') as { corr: () => Corr }).corr(),
    )
    check(`${label}: no reconciliation snap across the vault`, corr1.snap === corr0.snap, corr1)
    // The saloon's west wall (x = 47 at z = 40): a hop, and the wall still stops you.
    check(`${label}: reaches the saloon wall`, await walkTo(page, 44.5, 40))
    const wall = await runAndJump(page, 1, 0, `.playwright-mcp/vault-${label}-wall`)
    check(`${label}: no vault offered at a wall`, !wall.pressed)
    check(`${label}: the wall stops you (no vaulting buildings)`, wall.after.x < 47, wall.after)
    await page.context().close()
  }
} catch (e) {
  console.log('error:', e)
  code = 1
}
await browser.close()
process.exit(code || (failed() ? 1 : 0))
