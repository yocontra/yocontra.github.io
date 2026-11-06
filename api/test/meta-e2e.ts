/**
 * The solo meta-game end to end (meta-game stream), in Chrome with a WebAuthn virtual
 * authenticator, against the real Worker and site:
 *
 * 1. As a guest, play a real practice duel against outlaw 1 and win a medal (the toast, the map,
 *    the guest purse on the device).
 * 2. Sign up with a passkey: the guest purse migrates into the account once, capped, through the
 *    ledger (`guest_migration`), and "On the Books" unlocks.
 * 3. Ride out against the Daily Outlaw from the hub tile: a server-judged duel, paid once through
 *    the ledger (`daily_outlaw`), on the board.
 * 4. Achievements: First Blood and On the Books are on the sheet.
 * Screenshots of the new screens at 1440×900 and 375×812 go to `--shots`.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8822 --inspector-port 9262 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8822 bun --bun astro dev --port 4382 --ignore-lock
 *   bun api/test/meta-e2e.ts --site http://localhost:4382 --shots <dir>
 *
 * `RP_ORIGINS` and `ALLOWED_ORIGINS` in `api/.dev.vars` must include the site origin. Not part of
 * `bun test`.
 */
// biome-ignore-all lint/style/noPlaywrightWaitForSelector: the harness waits on the game's own DOM
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { chromium, type Page } from 'playwright'
import { check, failed, openLocalD1 } from './local-d1.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4382')
const SHOTS = arg('--shots', join(import.meta.dir, '../.wrangler/meta-shots'))
const OW = '/src/experiments/out-west'
const REACT_MS = 210
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
mkdirSync(SHOTS, { recursive: true })
const db = openLocalD1()

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('page error:', e.message))
if (process.argv.includes('--verbose')) {
  page.on('console', (m) => console.log('console:', m.text()))
}
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
})

/**
 * The call over a ranked or daily socket, seen in the page: when it will be presented (perf ms).
 * A no-bell day shows no DRAW!, so the socket's call is the only tell the harness has.
 */
await context.addInitScript({
  content: `(() => {
    const Native = globalThis.WebSocket
    class Watched extends Native {
      constructor(url, protocols) {
        super(url, protocols)
        this.addEventListener('message', (e) => {
          if (typeof e.data === 'string' && e.data.includes('"type":"call"')) {
            const m = JSON.parse(e.data)
            globalThis.__owCallAt = performance.now() + (m.inMs ?? 0)
          }
        })
      }
    }
    globalThis.WebSocket = Watched
  })()`,
})

/** Runs `body` in the page with the client's own module at `path` as `m`. */
function inPage<T>(p: Page, path: string, body: string): Promise<T> {
  return p.evaluate(
    async ({ url, code }) => {
      const m: unknown = await import(url)
      // biome-ignore lint/security/noGlobalEval: the harness runs its own snippets in the page under test
      const run = globalThis.eval as (src: string) => (mod: unknown) => Promise<T>
      return await run(`(async (m) => { ${code} })`)(m)
    },
    { url: `${OW}/${path}`, code: body },
  )
}

async function shot(name: string): Promise<void> {
  await sleep(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function toHub(): Promise<void> {
  await page.goto(`${SITE}/experiments/out-west/`)
  await page.waitForSelector('.ow-title.ready', { timeout: 60_000 })
  await page.keyboard.press('Space')
  await page.waitForSelector('.ow-hub.on', { timeout: 60_000 })
  await page.evaluate("document.querySelector('astro-dev-toolbar')?.remove()")
  await sleep(800)
}

/**
 * Walk (hold W) until the call, then fire `REACT_MS` after it. The wait and the shot run inside
 * the page (a frame-accurate watch on the DRAW! indicator or the socket's call), so the harness's
 * own latency never lands in the reaction.
 */
async function duel(timeoutMs = 90_000): Promise<void> {
  await page.evaluate('globalThis.__owCallAt = 0')
  await page.keyboard.down('KeyW')
  try {
    await page.evaluate(`new Promise((resolve, reject) => {
      const t0 = performance.now()
      const key = (type, code) =>
        globalThis.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }))
      const watch = () => {
        const now = performance.now()
        const at = Number(globalThis.__owCallAt ?? 0)
        const shown = document.querySelector('.ow-call-indicator.on') !== null
        if (shown || (at > 0 && now >= at)) {
          key('keyup', 'KeyW')
          setTimeout(() => {
            key('keydown', 'Space')
            setTimeout(() => key('keyup', 'Space'), 40)
            resolve()
          }, ${REACT_MS})
          return
        }
        if (now - t0 > ${timeoutMs}) {
          reject(new Error('no call'))
          return
        }
        requestAnimationFrame(watch)
      }
      requestAnimationFrame(watch)
    })`)
  } finally {
    await page.keyboard.up('KeyW')
  }
}

// ─── 1. a guest medal ────────────────────────────────────────────────────────────────────────────
console.log('\n1. As a guest: a practice duel and a medal')
await page.goto(`${SITE}/experiments/out-west/`)
await page.evaluate(() => localStorage.clear())
await toHub()
await shot('hub-guest-1440')
await page.locator('.ow-tile-gauntlet').click()
await page.locator('.ow-choice', { hasText: 'Practice' }).last().click()
await duel()
const medal = await page
  .waitForSelector('.ow-toast-medal', { timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
check('a medal toast after beating outlaw 1', medal)
await shot('toast-medal-1440')
const meta = await page.evaluate(() => JSON.parse(localStorage.getItem('out-west-meta') ?? '{}'))
check(
  'the device holds a medal on outlaw 1 and the first clear',
  (meta.marks?.[0]?.tier ?? 0) >= 1 && (meta.clears & 1) === 1,
  meta.marks?.[0],
)
check('First Blood unlocked', meta.achievements?.['ow.first-blood'] > 0, meta.achievements)

// the Gazette front page for outlaw 2 (the duel shows it before his poster once wired)
await sleep(6000)
const gazette = (await page.locator('.ow-gz.on').count()) > 0
if (gazette) {
  await shot('gazette-front-1440')
  await page.keyboard.press('Space')
}
console.log(`  · Gazette between duels: ${gazette ? 'shown' : 'not wired in this build yet'}`)

// back to the saloon with the progress on the device
await toHub()
const guestLine = await page.locator('.ow-hub-meta').textContent()
check('the hub shows the guest purse', (guestLine ?? '').includes('purse'), guestLine)
await page.locator('.ow-btn', { hasText: 'Gauntlet map' }).click()
await page.waitForSelector('.ow-map')
await shot('map-guest-1440')
await page.keyboard.press('Escape')

// ─── 2. sign up: the guest purse migrates once ──────────────────────────────────────────────────
console.log('\n2. Sign up: the guest purse migrates')
const rider = `Meta ${Date.now().toString(36).slice(-5)}`
const signUp = await inPage<{ ok: boolean }>(
  page,
  'net/auth.ts',
  `return await m.signUp(${JSON.stringify(rider)})`,
)
check('sign up with the virtual passkey', signUp.ok, signUp)
const account = db.query('SELECT id FROM accounts WHERE name = ?').get(rider) as {
  id: string
} | null
const id = account?.id ?? ''
let migration = null as { xp: number; cash: number } | null
for (let i = 0; i < 40 && !migration; i++) {
  await sleep(250)
  migration = db.query('SELECT xp, cash FROM guest_migrations WHERE account_id = ?').get(id) as {
    xp: number
    cash: number
  } | null
}
check('the guest purse migrated (guest_migrations row)', migration !== null, migration)
const ledgerRow = db
  .query("SELECT delta, xp FROM ledger WHERE account_id = ? AND kind = 'guest_migration'")
  .get(id) as { delta: number; xp: number } | null
check(
  'booked once through the ledger, within the cap',
  ledgerRow !== null && ledgerRow.delta <= 750 && ledgerRow.xp <= 2000 && ledgerRow.xp > 0,
  ledgerRow,
)
await page.waitForSelector('.ow-toast-purse', { timeout: 10_000 }).catch(() => null)
await shot('toast-purse-1440')
// a second migration from the same device is refused, and books nothing
const again = await inPage<{ ok: boolean; status: number }>(
  page,
  'net/meta.ts',
  'return await m.migrateGuest({ marks: [{ tier: 3, challenge: true }], clears: 131071 })',
)
check('a second migration is refused (409)', !again.ok && again.status === 409, again)
const rows = db
  .query("SELECT COUNT(*) AS n FROM ledger WHERE account_id = ? AND kind = 'guest_migration'")
  .get(id) as { n: number }
check('still exactly one guest_migration row', rows.n === 1, rows)

// ─── 3. the Daily Outlaw ─────────────────────────────────────────────────────────────────────────
console.log('\n3. The Daily Outlaw')
await toHub()
await shot('hub-signed-1440')
await page.locator('.ow-tile-daily').click()
await page.waitForSelector('.ow-daily .ow-btn-primary')
await shot('daily-sheet-1440')
await page.locator('.ow-daily .ow-btn-primary', { hasText: 'Ride out' }).click()
await duel()
const back = await page
  .waitForSelector('.ow-daily-big', { timeout: 30_000 })
  .then(() => true)
  .catch(() => false)
check('back at the saloon with the daily result', back)
await shot('daily-result-1440')
const dailyRun = db
  .query(
    'SELECT outcome, reaction_ms FROM daily_runs WHERE account_id = ? ORDER BY created_at DESC',
  )
  .get(id) as { outcome: string; reaction_ms: number | null } | null
check('the server judged a daily win', dailyRun?.outcome === 'win', dailyRun)
const paid = db
  .query("SELECT delta, xp FROM ledger WHERE account_id = ? AND kind = 'daily_outlaw'")
  .all(id) as { delta: number; xp: number }[]
check('the daily paid once: $50 and 75 XP', paid.length === 1 && paid[0]?.delta === 50, paid)
const board = await inPage<{ ok: boolean; value?: { rows: { name: string }[] } }>(
  page,
  'net/meta.ts',
  // biome-ignore lint/security/noSecrets: a snippet of the harness, not a secret
  'return await m.fetchDailyBoard()',
)
check(
  'on today’s board',
  board.ok && (board.value?.rows ?? []).some((r) => r.name === rider),
  board,
)
await page.keyboard.press('Escape')

// ─── 4. achievements ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Achievements')
const after = await page.evaluate(() => JSON.parse(localStorage.getItem('out-west-meta') ?? '{}'))
check('On the Books unlocked', after.achievements?.['ow.signed'] > 0, after.achievements)
check('Daily Bread unlocked', after.achievements?.['ow.daily-first'] > 0, after.achievements)
await page.locator('.ow-btn', { hasText: 'Achievements' }).first().click()
await page.waitForSelector('.ow-ach')
const earned = await page.locator('.ow-ach-list li.earned').count()
check('the sheet shows them earned', earned >= 3, earned)
await shot('achievements-1440')
await page.keyboard.press('Escape')
await page.locator('.ow-btn', { hasText: 'Gauntlet map' }).click()
await page.waitForSelector('.ow-map')
await shot('map-signed-1440')
await page.keyboard.press('Escape')
await inPage(
  page,
  'ui/gazette.ts',
  "m.showFrontPage(document.querySelector('.ow-hub').parentElement, 4); return null",
)
await shot('gazette-front-1440')
await page.keyboard.press('Space')
await sleep(1200)
await page.keyboard.press('Space')

// ─── phone ───────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. Phone screenshots (375×812)')
await page.setViewportSize({ width: 375, height: 812 })
await toHub()
await shot('hub-375')
await page.locator('.ow-btn', { hasText: 'Gauntlet map' }).click()
await page.waitForSelector('.ow-map')
await shot('map-375')
await page.keyboard.press('Escape')
await page.locator('.ow-tile-daily').click()
await page.waitForSelector('.ow-daily .ow-btn')
await shot('daily-sheet-375')
await page.keyboard.press('Escape')
await page.locator('.ow-btn', { hasText: 'Achievements' }).first().click()
await page.waitForSelector('.ow-ach')
await shot('achievements-375')
await page.keyboard.press('Escape')
await inPage(
  page,
  'ui/gazette.ts',
  "m.showFrontPage(document.querySelector('.ow-hub').parentElement, 9); return null",
)
await shot('gazette-front-375')
await page.keyboard.press('Space')
await inPage(
  page,
  'ui/gazette.ts',
  "m.showEpilogue(document.querySelector('.ow-hub').parentElement); return null",
)
await shot('gazette-epilogue-375')
await inPage(page, 'meta/progress.ts', 'return null')

await browser.close()
console.log(failed() === 0 ? '\nall good' : `\n${failed()} failed`)
process.exit(failed() === 0 ? 0 : 1)
