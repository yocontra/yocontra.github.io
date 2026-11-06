// biome-ignore-all lint/security/noSecrets: page-side JS expressions and selectors, not secrets
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear test script
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: real-time menus and duels: waits are beats, not flaky selectors
import { Database } from 'bun:sqlite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The saloon's menus and Bounty Hunt, in real Chrome against the real local API (`wrangler dev`,
 * with the site's `PUBLIC_API_URL` pointing at it and the site's origin in the API's
 * ALLOWED_ORIGINS and RP_ORIGINS), reading the `#audiodebug` timeline (`__owAudio`):
 *
 *   bunx wrangler d1 migrations apply contra-leaderboard --config api/wrangler.jsonc --local
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8787
 *   PUBLIC_API_URL=http://localhost:8787 bun run dev --port 4353
 *   PLAYWRIGHT=/abs/path/to/node_modules/playwright bun tools/audio/verify-ui.ts [baseUrl] [--d1=dir]
 *
 * Each player signs up with a real passkey (a CDP virtual authenticator) and is then given the
 * Bounty Hunt licence straight in the local D1 (`--d1`, default the API's wrangler state), the
 * only shortcut: everything else goes through the real Worker.
 *
 * Signs in, opens the Outfitter and buys something, opens the queue and takes a ghost, then plays
 * two duels against ghosts: a win (a quick draw) and a loss (no draw at all). Reports every UI cue,
 * the music and stings, the ghost's arrival and exit, any UI cue (or positional bell) between the
 * standoff and the call's hush lifting, and the bell over music and ambience at each call.
 */

interface Frame {
  t: number
  tap: string
  peak: number
  rms: number
}
interface Ev {
  t: number
  name: string
  args: string
}
interface Loc {
  first: () => Loc
  fill: (v: string) => Promise<void>
  click: (o?: { timeout?: number }) => Promise<void>
  isVisible: () => Promise<boolean>
  isEnabled: () => Promise<boolean>
  count: () => Promise<number>
  waitFor: (o?: { timeout?: number; state?: string }) => Promise<void>
}
interface Cdp {
  send: (method: string, params?: unknown) => Promise<unknown>
}
interface PageLike {
  context: () => { newCDPSession: (p: unknown) => Promise<Cdp> }
  goto: (url: string) => Promise<unknown>
  reload: () => Promise<unknown>
  waitForFunction: (fn: string, arg?: unknown, opts?: { timeout?: number }) => Promise<unknown>
  evaluate: <T>(fn: string) => Promise<T>
  locator: (sel: string) => Loc
  mouse: {
    click: (x: number, y: number) => Promise<void>
    down: () => Promise<void>
    up: () => Promise<void>
    move: (x: number, y: number) => Promise<void>
  }
  waitForTimeout: (ms: number) => Promise<void>
}
interface Pw {
  chromium: {
    launch: (o: unknown) => Promise<{
      newPage: (o: unknown) => Promise<PageLike>
      close: () => Promise<void>
    }>
  }
}

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4353'
const d1Dir =
  process.argv.find((a) => a.startsWith('--d1='))?.slice(5) ??
  join(import.meta.dir, '../../api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const RUN = Date.now().toString(36).slice(-4)
const pwPath = process.env.PLAYWRIGHT ?? 'playwright'
const { chromium } = (await import(pwPath)) as Pw
const f1 = (v: number) => v.toFixed(1)
const rmsDb = (xs: number[]) =>
  xs.length > 0 ? 10 * Math.log10(xs.reduce((a, d) => a + 10 ** (d / 10), 0) / xs.length) : -200
const UI = new Set([
  'uiPaper',
  'uiStamp',
  'uiTick',
  'uiBuy',
  'queueFound',
  'levelUp',
  'ghost',
  'ghostVanish',
])

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
/** Give `name` the Bounty Hunt licence (the first three outlaws) in the local D1. */
function license(name: string): void {
  const file = readdirSync(d1Dir).find((x) => x.endsWith('.sqlite') && !x.startsWith('metadata'))
  if (file === undefined) {
    throw new Error(`No local D1 in ${d1Dir}. Apply the migrations first.`)
  }
  const db = new Database(join(d1Dir, file))
  db.exec('PRAGMA busy_timeout = 5000')
  db.query(
    'UPDATE profiles SET gauntlet_clears = gauntlet_clears | 7 WHERE account_id = (SELECT id FROM accounts WHERE name = ?)',
  ).run(name)
  db.close()
}

/** A fresh browser context, signed up with a passkey as `name`, in the saloon with audio on. */
async function saloon(name: string): Promise<PageLike> {
  const pg = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const cdp = await pg.context().newCDPSession(pg)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await pg.goto(`${base}/experiments/out-west/#audiodebug`)
  // the dev toolbar sits over the results sheet's buttons
  await pg.evaluate('document.querySelector("astro-dev-toolbar")?.remove()')
  await pg.mouse.click(640, 360)
  await pg.waitForFunction('globalThis.__owAudio !== undefined', undefined, { timeout: 30_000 })
  await pg.locator('.ow-tile-store').waitFor({ timeout: 60_000 })
  const handle = `${name} ${RUN}`
  await pg.locator('.ow-hub-signin').click()
  await pg.locator('.ow-acct-input').fill(handle)
  await pg.locator('.ow-acct-form button:has-text("Sign up")').click()
  await pg.locator('.ow-acct-plate-name').waitFor({ timeout: 20_000 })
  license(handle)
  await pg.locator('.ow-sheet-head button:has-text("Close")').first().click()
  await pg.waitForTimeout(1500)
  return pg
}

const page = await saloon('Verifier')
const tiles = page.locator('.ow-tile-store')

const events = () => page.evaluate<Ev[]>('globalThis.__owAudio.events')
const waitEvent = async (pred: (e: Ev) => boolean, ms: number, from = 0): Promise<Ev | null> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const e = (await events()).slice(from).find(pred)
    if (e) {
      return e
    }
    await page.waitForTimeout(50)
  }
  return null
}
const mark = async () => (await events()).length

// --- the Outfitter: browse, pick, buy
console.log('store: open, pick an item, buy it')
await tiles.click()
await page.locator('.ow-item').first().waitFor({ timeout: 10_000 })
await page.waitForTimeout(800)
const priced = page.locator('.ow-item:has(.ow-item-tag:text-matches("^\\\\$"))')
const n = await priced.count()
let bought = false
for (let i = 0; i < n && !bought; i++) {
  await page.evaluate(
    `[...document.querySelectorAll('.ow-item')].filter((b) => /^\\$/.test(b.querySelector('.ow-item-tag')?.textContent ?? ''))[${i}]?.click()`,
  )
  await page.waitForTimeout(300)
  const buy = page
    .locator('.ow-store-detail button:has-text("Buy ·"), button:has-text("Buy ·")')
    .first()
  if ((await buy.count()) > 0 && (await buy.isEnabled())) {
    await buy.click()
    await page.locator('.ow-sheet button.ow-btn-primary:has-text("Buy")').first().click()
    bought = true
  }
}
await page.waitForTimeout(1500)
console.log('  bought:', bought)
await page.locator('button:has-text("Done")').first().click()
await page.waitForTimeout(800)

// --- Bounty Hunt: the queue, a ghost, a win then a loss
console.log('queue: open, take a ghost')
await page.locator('.ow-tile-bounty').click()
const ghostBtn = page.locator('button:has-text("Duel a ghost now")')
await ghostBtn.waitFor({ timeout: 30_000, state: 'visible' })
await ghostBtn.click()

interface Round {
  call: Ev | null
  frames: Frame[]
}
/** One duel: ready, walk, wait for the call, then draw after `reactMs` (null: never draw). */
async function duel(reactMs: number | null): Promise<Round> {
  const ready = page.locator('button:has-text("Ready")')
  await ready.first().waitFor({ timeout: 30_000, state: 'visible' })
  await page.waitForFunction(
    '[...document.querySelectorAll("button")].some((b) => b.textContent === "Ready" && !b.disabled)',
    undefined,
    { timeout: 30_000 },
  )
  await ready.first().click()
  const from = await mark()
  await page.mouse.move(640, 500)
  await page.mouse.down()
  const standoff = await waitEvent(
    (e) => e.name === 'musicLevel' && Number(e.args.split(',')[0]) <= -7,
    60_000,
    from,
  )
  await page.mouse.up()
  const call = await waitEvent(
    (e) => e.name === 'play' && e.args.startsWith('bell') && e.args.includes('"priority":true'),
    30_000,
    from,
  )
  if (call && reactMs !== null) {
    await page.waitForTimeout(reactMs)
    await page.mouse.click(640, 500)
  }
  console.log(`  standoff ${Boolean(standoff)}, call ${Boolean(call)}`)
  await page.waitForTimeout(9000)
  return { call, frames: await page.evaluate<Frame[]>('globalThis.__owAudio.frames') }
}

console.log('duel 1: a quick draw (win)')
const r1 = await duel(150)
console.log('duel 2: the next bounty (another ghost), no draw (loss)')
await page.locator('button:has-text("Next bounty")').first().click()
await ghostBtn.waitFor({ timeout: 30_000, state: 'visible' })
await ghostBtn.click()
const r2 = await duel(null)
await page.locator('button:has-text("Saloon")').first().click()
await page.waitForTimeout(2500)

// --- two live guns in the queue at once: a match is found (queueFound), then both flee
console.log('queue: two players, a live match')
const other = await saloon('Rival')
await page.locator('.ow-tile-bounty').click()
await other.locator('.ow-tile-bounty').click()
const found = await waitEvent(
  (e) => e.name === 'play' && e.args.startsWith('queueFound'),
  20_000,
  await mark(),
)
console.log(`  match found cue: ${Boolean(found)}`)
await page.waitForTimeout(3000)

const all = await events()
const frames = await page.evaluate<Frame[]>('globalThis.__owAudio.frames')
await browser.close()

const t0 = all[0]?.t ?? 0
const at = (e: Ev) => `${f1(e.t - t0)}s`
console.log('\ntimeline (UI cues, music, stings, calls):')
for (const e of all) {
  const head = e.args.split(',')[0] ?? ''
  const ui = e.name === 'play' && UI.has(head)
  if (
    ui ||
    e.name === 'playSong' ||
    e.name === 'sting' ||
    e.name === 'hushUi' ||
    e.name === 'uiHushed' ||
    (e.name === 'play' && head === 'bell')
  ) {
    console.log(`  ${at(e)} ${e.name} ${e.args.slice(0, 70)}`)
  }
}
const count = (name: string) =>
  all.filter((e) => e.name === 'play' && e.args.split(',')[0] === name).length
console.log('\nUI cue counts:', [...UI].map((u) => `${u}:${count(u)}`).join(' '))
console.log(
  'stings:',
  all
    .filter((e) => e.name === 'sting')
    .map((e) => e.args)
    .join(' '),
)
// Nothing from the UI between the standoff hush and its lift (nor a positional bell, ever).
let hushed = false as boolean
let leaks = 0
for (const e of all) {
  if (e.name === 'hushUi') {
    hushed = e.args === 'true'
  } else if (hushed && e.name === 'play' && UI.has(e.args.split(',')[0] ?? '')) {
    leaks++
  }
}
const posBells = all.filter(
  (e) => e.name === 'play' && e.args.startsWith('bell') && e.args.includes('"pos"'),
)
console.log(
  `UI cues played while hushed: ${leaks}; positional bells (the death knell, never the call): ${posBells.length}`,
)
for (const [i, r] of [r1, r2].entries()) {
  if (!r.call) {
    continue
  }
  const tb = Number(r.call.args.match(/"when":(?<w>[\d.]+)/u)?.groups?.w ?? r.call.t)
  const w = (tap: string) =>
    rmsDb(r.frames.filter((f) => f.tap === tap && f.t >= tb && f.t < tb + 0.7).map((f) => f.rms))
  console.log(
    `duel ${i + 1} call: sfx ${f1(w('sfx'))}  music ${f1(w('music'))}  amb ${f1(w('amb'))} → bell over music ${f1(w('sfx') - w('music'))} dB, over ambience ${f1(w('sfx') - w('amb'))} dB`,
  )
}
const out = frames.filter((f) => f.tap === 'out')
console.log(`output peak ${f1(Math.max(...out.map((f) => f.peak)))} dBFS`)
