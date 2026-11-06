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
import { makeMoveState } from '../../src/experiments/out-west/ffa/sim/types.ts'
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

const move = (x: number, z: number) => makeMoveState(x, z)
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

/**
 * A building wall to run at: 2.5 m out from the middle of a side, nothing in the way but the
 * wall itself (the first blocked step lands on the building's face). `plane` is the face's
 * coordinate along the run.
 */
function wallRuns(): (Run & { plane: number })[] {
  const runs: (Run & { plane: number })[] = []
  for (const b of TOWN.buildings) {
    const cx = b.x + b.w / 2
    const cz = b.z + b.d / 2
    const sides = [
      { x: b.x - 2.5 - PLAYER_RADIUS, z: cz, dx: 1, dz: 0, plane: b.x },
      { x: b.x + b.w + 2.5 + PLAYER_RADIUS, z: cz, dx: -1, dz: 0, plane: -(b.x + b.w) },
      { x: cx, z: b.z - 2.5 - PLAYER_RADIUS, dx: 0, dz: 1, plane: b.z },
      { x: cx, z: b.z + b.d + 2.5 + PLAYER_RADIUS, dx: 0, dz: -1, plane: -(b.z + b.d) },
    ]
    for (const r of sides) {
      const roomy = [0, Math.PI / 2, Math.PI, -Math.PI / 2].every((a) =>
        free(r.x + Math.cos(a) * 0.8, r.z + Math.sin(a) * 0.8),
      )
      if (!(free(r.x, r.z) && roomy)) {
        continue
      }
      let hit = -1
      let vaultable = false
      for (let t = 0.05; t <= 3.5; t += 0.05) {
        const at = move(r.x + r.dx * t, r.z + r.dz * t)
        vaultable ||= vaultDistance(grid, at, r.dx, r.dz) > 0
        if (!free(at.x, at.z)) {
          hit = t
          break
        }
      }
      const face = (r.x + r.dx * hit) * r.dx + (r.z + r.dz * hit) * r.dz
      if (!vaultable && hit > 2 && Math.abs(face + PLAYER_RADIUS - r.plane) < 0.3) {
        runs.push({ ...r, cover: { x: b.x, z: b.z, w: b.w, d: b.d } })
      }
    }
  }
  runs.sort((a, b) => Math.hypot(a.x - 72, a.z - 64) - Math.hypot(b.x - 72, b.z - 64))
  if (runs.length === 0) {
    throw new Error('no building wall to run at in this layout')
  }
  return runs
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
    () => (Reflect.get(globalThis, '__frontier') as (() => State) | undefined)?.().alive === true,
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

async function walkTo(page: Page, x: number, z: number, attempts = 3): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await pilot(page, 'go', x, z)
    for (let i = 0; i < 100; i++) {
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
  const walls = wallRuns()
  console.log(
    `  fence at (${run.cover.x}, ${run.cover.z}) ${run.cover.w}×${run.cover.d}; run-up from (${run.x}, ${run.z})`,
  )
  for (const touch of [false, true]) {
    const label = touch ? 'touch' : 'desktop'
    const page = await rider(browser, label, touch)
    check(`${label}: reaches the fence`, await walkTo(page, run.x, run.z))
    // only the vault itself counts (the walk there may correct as it settles in)
    const corr0 = await page.evaluate(() =>
      (Reflect.get(globalThis, '__frontierTrace') as { corr: () => Corr }).corr(),
    )
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
    // A building's wall: a jump there is a hop, and the wall still stops you.
    // the nearest wall run the autopilot can route to
    let wr = walls[0] as (typeof walls)[number]
    let reached = false
    const here = await state(page)
    const near = [...walls].sort(
      (a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z),
    )
    for (const w of near.slice(0, 4)) {
      wr = w
      reached = await walkTo(page, w.x, w.z, 1)
      if (reached) {
        break
      }
    }
    check(`${label}: reaches a building wall`, reached, wr)
    const wall = await runAndJump(page, wr.dx, wr.dz, `.playwright-mcp/vault-${label}-wall`)
    const along = wall.after.x * wr.dx + wall.after.z * wr.dz
    check(`${label}: no vault offered at a wall`, !wall.pressed)
    check(`${label}: the wall stops you (no vaulting buildings)`, along < wr.plane, wall.after)
    await page.context().close()
  }
} catch (e) {
  console.log('error:', e)
  code = 1
}
await browser.close()
process.exit(code || (failed() ? 1 : 0))
