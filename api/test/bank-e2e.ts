/**
 * Frontier banking, end to end: two real riders in two Chromium pages (the real client, the real
 * Worker, the real Lobby DO, the local D1), driven through the dev autopilot (`?debug`).
 *
 * The town runs with `?bots=0`, so the two riders are alone in it. Then:
 *
 * 1. B kills A, so B carries a kill bounty (A carried nothing, so A drops nothing).
 * 2. A respawns, walks up to B and kills B: B's carry spills (70% bag, 30% burned) and A carries
 *    its own kill bounty.
 * 3. A walks onto B's bag (A has the 2 s exclusivity) and picks it up.
 * 4. A walks to a bank window and holds E for the 2 s channel: one `ffa_deposit` ledger row for A,
 *    A's purse grows by exactly that amount, and the HUD's banked figure follows.
 * 5. "Lose it if you die before banking": B's purse never moved and B has no deposit row, though
 *    B carried money; it was spilled, not banked.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8809 --inspector-port 9249 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8809 bun run dev --port 4369
 *   bun api/test/bank-e2e.ts [--site http://localhost:4369] [--headed] [--verbose]
 *
 * `ALLOWED_ORIGINS` in `api/.dev.vars` must include the site origin, and the local D1 must be
 * migrated. Not part of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: the riders are polled one step at a time, on purpose
import process from 'node:process'
import { type Browser, chromium, type Page } from 'playwright'
import { BTN_FIRE, BTN_INTERACT, BTN_RELOAD } from '../../src/experiments/out-west/contract/town.ts'
import { BAG_PICKUP_RADIUS } from '../../src/experiments/out-west/ffa/sim/constants.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4369')
const VERBOSE = process.argv.includes('--verbose')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const db = openLocalD1()

interface Other {
  id: number
  x: number
  z: number
  alive: boolean
}
interface Bag {
  id: number
  x: number
  z: number
  amount: number
}
interface State {
  x: number
  z: number
  you: number
  alive: boolean
  hp: number
  carried: number
  banked: number
  channel: number
  ammo: number
  others: Other[]
  bags: Bag[]
}

const purse = (id: string): number =>
  db.query<{ purse: number }, [string]>('SELECT purse FROM profiles WHERE account_id = ?').get(id)
    ?.purse ?? -1
const deposits = (id: string): { delta: number; idem_key: string }[] =>
  db
    .query<{ delta: number; idem_key: string }, [string]>(
      "SELECT delta, idem_key FROM ledger WHERE account_id = ? AND kind = 'ffa_deposit' ORDER BY id",
    )
    .all(id)

class Rider {
  readonly label: string
  readonly page: Page
  readonly accountId: string

  constructor(label: string, page: Page, accountId: string) {
    this.label = label
    this.page = page
    this.accountId = accountId
  }

  state(): Promise<State> {
    return this.page.evaluate(() => {
      const f = Reflect.get(globalThis, '__frontier') as (() => unknown) | undefined
      return (f ? f() : {}) as State
    })
  }

  pilot(call: string, ...args: number[]): Promise<unknown> {
    return this.page.evaluate(
      ({ c, a }) => {
        const p = Reflect.get(globalThis, '__frontierPilot') as Record<
          string,
          (...v: number[]) => unknown
        >
        return p[c]?.(...a)
      },
      { c: call, a: args },
    )
  }

  /** Walk to (x, z), re-planning as needed. Resolves once within `near` metres. */
  async walkTo(
    x: number,
    z: number,
    near = 0.6,
    timeoutMs = 40_000,
    arrived: (s: State) => boolean = () => false,
  ): Promise<boolean> {
    const until = Date.now() + timeoutMs
    let lastPlan = 0
    let last = { x: Number.NaN, z: Number.NaN, at: Date.now() }
    while (Date.now() < until) {
      const s = await this.state()
      if (!s.alive) {
        await this.pilot('stop')
        return false
      }
      const d = Math.hypot(s.x - x, s.z - z)
      if (d <= near || arrived(s)) {
        await this.pilot('stop')
        return true
      }
      const moved = Math.hypot(s.x - last.x, s.z - last.z)
      if (moved > 0.2) {
        last = { x: s.x, z: s.z, at: Date.now() }
      }
      const stuck = Date.now() - last.at > 1200
      const walking = (await this.pilot('walking')) as boolean
      if (!walking || stuck || Date.now() - lastPlan > 4000) {
        const ok = (await this.pilot('go', x, z)) as boolean
        if (!ok && VERBOSE) {
          console.log(`  ${this.label}: no path from (${s.x}, ${s.z}) to (${x}, ${z})`)
        }
        lastPlan = Date.now()
        last.at = Date.now()
      }
      await sleep(150)
    }
    await this.pilot('stop')
    return false
  }

  /**
   * Walk up to `victim` (its own page says where it is, even when it's outside this rider's
   * interest radius), stop within `range` m and fire until it's down. Closes in further when
   * shots stop landing (cover in the way).
   */
  async kill(victim: Rider, range = 7, timeoutMs = 90_000): Promise<boolean> {
    const until = Date.now() + timeoutMs
    const id = (await victim.state()).you
    let reach = range
    let misses = 0
    let lastHp = Number.NaN
    while (Date.now() < until) {
      const [s, v] = await Promise.all([this.state(), victim.state()])
      if (!v.alive) {
        await this.pilot('stop')
        return true
      }
      if (!s.alive) {
        await sleep(300)
        continue
      }
      const d = Math.hypot(s.x - v.x, s.z - v.z)
      if (d > reach) {
        await this.pilot('go', v.x, v.z)
        await sleep(300)
        continue
      }
      await this.pilot('stop')
      await this.pilot('aimAt', id)
      if (s.ammo === 0) {
        await this.pilot('tap', BTN_RELOAD)
        await sleep(400)
        continue
      }
      misses = v.hp < lastHp ? 0 : misses + 1
      lastHp = v.hp
      if (misses > 5) {
        reach = Math.max(2, reach - 2)
        misses = 0
      }
      await this.pilot('tap', BTN_FIRE)
      await sleep(330)
    }
    return false
  }

  async waitFor(what: string, test: (s: State) => boolean, timeoutMs = 20_000): Promise<State> {
    const until = Date.now() + timeoutMs
    let s = await this.state()
    while (Date.now() < until) {
      if (test(s)) {
        return s
      }
      await sleep(150)
      s = await this.state()
    }
    throw new Error(`${this.label}: timed out waiting for ${what} (${JSON.stringify(s)})`)
  }
}

async function ride(chrome: Browser, label: string, name: string): Promise<Rider> {
  const player = await seedPlayer(db, { name, purse: 500, clears: 7 })
  const ctx = await chrome.newContext({ viewport: { width: 960, height: 600 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`${label} page error:`, e.message))
  if (VERBOSE) {
    page.on('console', (m) => console.log(`${label} console:`, m.text()))
  }
  const q = new URLSearchParams({
    server: 'remote',
    bots: '0',
    lobby: 'lobby:0',
    debug: '1',
    token: player.token,
  })
  await page.goto(`${SITE}/experiments/out-west/frontier/?${q.toString()}#tier=legacy`)
  const rider = new Rider(label, page, player.id)
  await rider.waitFor('the town', (s) => typeof s.you === 'number' && s.you >= 0 && s.alive, 60_000)
  return rider
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !process.argv.includes('--headed'),
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
})
let code = 0
try {
  console.log('Frontier banking, end to end')
  const a = await ride(browser, 'A', 'Bank Rider')
  const b = await ride(browser, 'B', 'Bag Rider')
  // Spawns are far apart (and snapshots only carry riders within the interest radius): meet on
  // main street first, a few metres apart.
  const [metA, metB] = await Promise.all([a.walkTo(60, 64, 1.5), b.walkTo(66, 64, 1.5)])
  check('both riders meet on main street', metA && metB)
  await a.waitFor('B in view', (s) => s.others.length > 0, 30_000)
  // a rider from an earlier run may linger its 10 s (§3.3) before the lobby lets it go
  await a.waitFor('the town to empty of strangers', (s) => s.others.length === 1, 20_000)
  const sa = await a.state()
  const sb = await b.state()
  check(
    'with ?bots=0 the town holds only the two riders',
    sa.others.length === 1 && sb.others.length === 1,
    { a: sa.others, b: sb.others },
  )
  const aPurse0 = purse(a.accountId)
  const bPurse0 = purse(b.accountId)

  // 1. B kills A: B now carries a bounty.
  check('B kills A', await b.kill(a))
  const bCarry = (await b.waitFor('B carrying', (s) => s.carried > 0)).carried
  check('B carries a kill bounty', bCarry > 0, bCarry)
  check('A dropped no bag (A carried nothing)', (await b.state()).bags.length === 0)

  // 2. A respawns and kills B (well past B's 8 s pardon window by now).
  await a.waitFor('A respawned', (s) => s.alive && s.hp > 0, 15_000)
  await sleep(3500) // A's spawn protection wears off (or ends on the first shot)
  check('A kills B', await a.kill(b))
  const aCarry0 = (await a.waitFor('A carrying', (s) => s.carried > 0)).carried
  const withBag = await a.waitFor('B’s bag', (s) => s.bags.length > 0, 5000)
  const bag = withBag.bags[0] as Bag
  const bagFloor = Math.max(10, Math.floor(bCarry * 0.7))
  check(
    `B’s carry spilled: a $${bag.amount} bag (70% of $${bCarry}, floor $10)`,
    Math.abs(bag.amount - bagFloor) <= 1,
    { bag, bCarry },
  )
  check(
    'B respawns with nothing carried',
    (await b.waitFor('B dead', (s) => !s.alive)).carried === 0,
  )

  // 3. A picks up the bag.
  // the bag may lie against cover where its exact spot isn't walkable: arriving is picking it up
  const onBag = await a.walkTo(bag.x, bag.z, BAG_PICKUP_RADIUS - 0.3, 40_000, (st) =>
    st.bags.every((g) => g.id !== bag.id),
  )
  check('A walks onto the bag', onBag)
  const picked = await a.waitFor('A picked the bag up', (s) => s.carried >= aCarry0 + bag.amount)
  check(
    `A carries $${picked.carried} ($${aCarry0} bounty + $${bag.amount} bag)`,
    picked.carried === aCarry0 + bag.amount,
    picked,
  )

  // 4. A banks at the nearest window.
  const windows = TOWN.zones.filter((zn) => zn.kind === 'bank')
  const win = windows.reduce((best, w) =>
    Math.hypot(w.x - picked.x, w.z - picked.z) < Math.hypot(best.x - picked.x, best.z - picked.z)
      ? w
      : best,
  )
  check(`A reaches the bank window (${win.id})`, await a.walkTo(win.x, win.z, win.r - 0.3, 60_000))
  const carry = (await a.state()).carried
  await a.pilot('stop')
  await sleep(300)
  await a.pilot('tap', BTN_INTERACT)
  await a.waitFor('the bank channel', (s) => s.channel !== 0, 3000)
  const banked = await a.waitFor('the deposit', (s) => s.carried === 0 && s.channel === 0, 8000)
  check('A carries nothing after banking', banked.carried === 0, banked)
  let rows = deposits(a.accountId)
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    await sleep(250) // deposits settle in D1 every 2 s
    rows = deposits(a.accountId)
  }
  const row = rows[0]
  check('one ffa_deposit ledger row for A', rows.length === 1, rows)
  check(`the row is the whole carry ($${carry})`, row?.delta === carry, { row, carry })
  check(`A's purse $${aPurse0} → $${purse(a.accountId)}`, purse(a.accountId) === aPurse0 + carry, {
    before: aPurse0,
    after: purse(a.accountId),
  })
  const hud = await a.waitFor('the HUD purse', (s) => s.banked === aPurse0 + carry, 5000)
  check('the HUD shows the new purse', hud.banked === aPurse0 + carry, hud.banked)

  // 5. Dying before banking loses the carry: B's purse never moved, and B has no deposit.
  check(
    `B died before banking: purse still $${bPurse0}, no deposit`,
    purse(b.accountId) === bPurse0 && deposits(b.accountId).length === 0,
    { purse: purse(b.accountId), rows: deposits(b.accountId) },
  )
} catch (err) {
  console.log('  ✗', err instanceof Error ? err.message : err)
  code = 1
} finally {
  await browser.close()
}
const ok = failed() === 0 && code === 0
console.log(ok ? '\nall checks passed' : `\nFAILED (${failed()} check(s), aborted: ${code !== 0})`)
process.exit(ok ? 0 : 1)
