/**
 * The practice town, played in Chrome the way the premium reviewer's harness did: the dev
 * autopilot locks its yaw onto the nearest rider 250 ms after one comes within 20 m and fires
 * every 380–630 ms; with nothing to shoot it walks to the nearest bag, and while carrying it walks
 * to the nearest bank window and presses interact. Reports kill/death, average life, time to the
 * first bank and money banked, from the game's own round counters.
 *
 *   bun --bun astro dev --port 4421 --ignore-lock
 *   bun api/test/frontier-practice.ts [--site http://localhost:4421] [--secs 300] [--touch]
 *     [--fresh] [--shots dir]
 *
 * `--fresh` clears the device record first (a brand-new player: green bots). `--touch` plays at
 * 812×375 with touch emulation. Not part of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: the play loop is one step after another
import process from 'node:process'
import { chromium } from 'playwright'
import { BTN_AIM, BTN_FIRE, BTN_INTERACT } from '../../src/experiments/out-west/contract/town.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4421')
const SECS = Number(arg('--secs', '300'))
const TOUCH = process.argv.includes('--touch')
const FRESH = process.argv.includes('--fresh')
const SHOTS = arg('--shots', '')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Other {
  id: number
  x: number
  z: number
  alive: boolean
}
interface Debug {
  x: number
  z: number
  you: number
  alive: boolean
  carried: number
  banked: number
  howto: boolean
  round: { kills: number; deaths: number; banked: number; open: boolean; objective: string | null }
  others: Other[]
  bags: { x: number; z: number }[]
}

const banks = TOWN.zones.filter((z) => z.kind === 'bank')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext(
  TOUCH
    ? { viewport: { width: 812, height: 375 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 800 } },
)
const page = await ctx.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${SITE}/experiments/out-west/frontier/?server=loopback&debug=1`)
if (FRESH) {
  await page.evaluate(() => {
    localStorage.removeItem('ow.frontier.record.v1')
    localStorage.removeItem('ow.frontier.coach.v1')
  })
  await page.reload()
}
await page.waitForFunction(
  () => typeof Reflect.get(globalThis, '__frontier') === 'function',
  null,
  {
    timeout: 60_000,
  },
)
await page.waitForFunction(
  () => (Reflect.get(globalThis, '__frontier') as () => { alive: boolean })().alive,
  null,
  { timeout: 60_000 },
)
const dbg = (): Promise<Debug> =>
  page.evaluate(() => (Reflect.get(globalThis, '__frontier') as () => Debug)())
const pilot = (fn: string, ...args: number[]): Promise<void> =>
  page.evaluate(
    ([f, a]) => {
      const p = Reflect.get(globalThis, '__frontierPilot') as Record<
        string,
        (...x: number[]) => void
      >
      p[f as string]?.(...(a as number[]))
    },
    [fn, args] as const,
  )
await page.evaluate(() =>
  (Reflect.get(globalThis, '__frontierView') as { closeHowTo: () => void }).closeHowTo(),
)

const t0 = Date.now()
let target = -1
let seenAt = 0
let nextFire = 0
let firstBank: number | null = null
let wasAlive = true
let lifeAt = Date.now()
const lives: number[] = []
let shot = 0
while (Date.now() - t0 < SECS * 1000) {
  const d = await dbg()
  const now = Date.now()
  if (d.round.open) {
    // the round summary: ride again
    await page.keyboard.press('Enter')
  }
  if (d.alive !== wasAlive) {
    if (d.alive) {
      lifeAt = now
    } else {
      lives.push((now - lifeAt) / 1000)
    }
    wasAlive = d.alive
  }
  if (firstBank === null && d.round.banked > 0) {
    firstBank = (now - t0) / 1000
  }
  if (SHOTS && now - t0 > shot * 30_000) {
    await page.screenshot({ path: `${SHOTS}/practice-${TOUCH ? 'touch' : 'desk'}-${shot}.png` })
    shot++
  }
  if (!d.alive) {
    await sleep(100)
    continue
  }
  let best: Other | null = null
  let bestD = 20
  for (const o of d.others) {
    const dd = Math.hypot(o.x - d.x, o.z - d.z)
    if (o.alive && o.id !== d.you && dd < bestD) {
      best = o
      bestD = dd
    }
  }
  if (best?.id !== target) {
    target = best?.id ?? -1
    seenAt = now
  }
  if (best && now - seenAt >= 250) {
    await pilot('stop')
    await pilot('aimAt', best.id)
    await pilot('hold', BTN_AIM, 1)
    if (now >= nextFire) {
      await pilot('tap', BTN_FIRE)
      nextFire = now + 380 + Math.random() * 250
    }
  } else {
    await pilot('hold', BTN_AIM, 0)
    const zone = banks.find((z) => Math.hypot(z.x - d.x, z.z - d.z) < z.r)
    if (d.carried > 0 && zone) {
      await pilot('stop')
      await pilot('tap', BTN_INTERACT)
    } else {
      const walking = await page.evaluate(() =>
        (Reflect.get(globalThis, '__frontierPilot') as { walking: () => boolean }).walking(),
      )
      if (!walking) {
        let goal: { x: number; z: number } | undefined
        if (d.carried > 0) {
          goal = banks.toSorted(
            (a, b) => Math.hypot(a.x - d.x, a.z - d.z) - Math.hypot(b.x - d.x, b.z - d.z),
          )[0]
        } else {
          goal = d.bags.toSorted(
            (a, b) => Math.hypot(a.x - d.x, a.z - d.z) - Math.hypot(b.x - d.x, b.z - d.z),
          )[0]
          goal ??= TOWN.spawns[Math.floor(Math.random() * TOWN.spawns.length)]
        }
        if (goal) {
          await pilot('go', goal.x, goal.z)
        }
      }
    }
  }
  await sleep(100)
}
const d = await dbg()
if (d.alive) {
  lives.push((Date.now() - lifeAt) / 1000)
}
const kills = d.round.kills
const deaths = d.round.deaths
console.log(
  JSON.stringify({
    touch: TOUCH,
    secs: SECS,
    kills,
    deaths,
    kd: Number((kills / Math.max(1, deaths)).toFixed(2)),
    avgLife: Number((lives.reduce((a, b) => a + b, 0) / Math.max(1, lives.length)).toFixed(1)),
    firstBank,
    bankedRound: d.round.banked,
    purse: d.banked,
    objective: d.round.objective,
    errors,
  }),
)
await browser.close()
