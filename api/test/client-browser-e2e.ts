/**
 * The real client against the real Worker, in Chromium (Playwright) with a WebAuthn virtual
 * authenticator. It signs up with a passkey through the client's own `net/auth.ts`, then drives
 * the client's own network modules (`net/social.ts`, `net/api.ts`, `net/ranked.ts`) and the hub's
 * "while you were away" notice:
 *
 * 1. Dye job, name change, a round for the house, the board and a poster, blocks and a report.
 * 2. A ghost royalty booked while away shows on the hub's notice; "Much obliged" acknowledges it,
 *    and the next `GET /me` has nothing left to report.
 * 3. A ranked run: two wins, the Worker restarts mid-duel, the client's RankedSession resumes on
 *    its own (the server's `hello.resumed` reaches the client) and the run carries on.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8799 --inspector-port 9239 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8799 bun run dev --port 4354
 *   bun api/test/client-browser-e2e.ts [--site http://localhost:4354]
 *
 * `RP_ORIGINS` and `ALLOWED_ORIGINS` in `api/.dev.vars` must include the site origin. Not part of
 * `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import { check, failed, openLocalD1 } from './local-d1.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4354')
const OW = '/src/experiments/out-west'
const RELOAD_TRIGGER = join(import.meta.dir, '../src/tuning.ts')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const db = openLocalD1()

/** Playwright's own Chromium if it's installed for this version, else a local Chrome. */
const CHROMES = [
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const executablePath = CHROMES.find((p) => existsSync(p))
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('page error:', e.message))
if (process.argv.includes('--verbose')) {
  page.on('console', (m) => console.log('console:', m.text()))
  page.on('websocket', (ws) => {
    console.log('ws open:', ws.url())
    ws.on('close', () => console.log('ws closed:', ws.url()))
    ws.on('socketerror', (e) => console.log('ws error:', e))
  })
}
const cdp = await page.context().newCDPSession(page)
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
await page.goto(`${SITE}/experiments/out-west/`)

/** Runs `body` in the page with the client's own module at `path` as `m`. */
function inPage<T>(path: string, body: string): Promise<T> {
  return page.evaluate(
    async ({ url, code }) => {
      const m: unknown = await import(url)
      // biome-ignore lint/security/noGlobalEval: the harness runs its own snippets in the page under test
      const run = globalThis.eval as (src: string) => (mod: unknown) => Promise<T>
      return await run(`(async (m) => { ${code} })`)(m)
    },
    { url: `${OW}/${path}`, code: body },
  )
}

const name = `Browser ${Date.now().toString(36).slice(-5)}`
const signUp = await inPage<{ ok: boolean }>(
  'net/auth.ts',
  `return await m.signUp(${JSON.stringify(name)})`,
)
check(
  'sign up with the virtual passkey (client net/auth.ts → Worker)',
  signUp.ok,
  JSON.stringify(signUp),
)
const account = db.query('SELECT id FROM accounts WHERE name = ?').get(name) as {
  id: string
} | null
const id = account?.id ?? ''

/** Books a ledger row the way the Worker does (row plus purse), for setup only. */
function book(kind: string, delta: number): void {
  const purse = (
    db.query('SELECT purse FROM profiles WHERE account_id = ?').get(id) as { purse: number }
  ).purse
  db.query(
    `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
     VALUES (?, ?, 0, ?, ?, 'browser-e2e', ?, 'browser-e2e', ?)`,
  ).run(
    id,
    delta,
    purse + delta,
    kind,
    `browser-e2e:${id}:${kind}:${crypto.randomUUID()}`,
    Date.now(),
  )
  db.query('UPDATE profiles SET purse = purse + ? WHERE account_id = ?').run(delta, id)
}

async function sinks(): Promise<void> {
  console.log('\n1. The money sinks and the social calls, through the client')
  book('admin_adjust', 10_000)
  // The first GET /me sets the away mark's baseline; acknowledge whatever the sign-up left.
  const me0 = await inPage<{ ok: boolean; value: { away: { asOf: number } } }>(
    'net/api.ts',
    'return await m.fetchMe()',
  )
  await inPage('net/social.ts', `return await m.ackAway(${me0.value.away.asOf})`)
  const dye = await inPage<{
    ok: boolean
    value?: { price: number; dyes: Record<string, string> }
  }>('net/social.ts', `return await m.dyeItem('hat.battered-brim', 'oxblood')`)
  check(
    'dyeItem',
    dye.ok && dye.value?.price === 500 && dye.value.dyes['hat.battered-brim'] === 'oxblood',
    JSON.stringify(dye),
  )
  const renamed = `${name} II`.slice(0, 16)
  const nc = await inPage<{ ok: boolean; value?: { name: string } }>(
    'net/social.ts',
    `return await m.changeName(${JSON.stringify(renamed)})`,
  )
  check('changeName', nc.ok && nc.value?.name === renamed, JSON.stringify(nc))
  const round = await inPage<{ ok: boolean; value?: { rounds: { name: string }[] } }>(
    'net/social.ts',
    'return await m.buyRound()',
  )
  check(
    'buyRound puts the new name on the chalkboard',
    round.ok && round.value?.rounds[0]?.name === renamed,
    JSON.stringify(round),
  )
  const board = await inPage<{ ok: boolean; value?: { month: string } }>(
    'net/social.ts',
    'return await m.fetchMostWanted()',
  )
  check(
    'fetchMostWanted',
    board.ok && typeof board.value?.month === 'string',
    JSON.stringify(board),
  )
  const poster = await inPage<{ ok: boolean; value?: { name: string } }>(
    'net/social.ts',
    `return await m.fetchPoster(${JSON.stringify(renamed)})`,
  )
  check('fetchPoster', poster.ok && poster.value?.name === renamed, JSON.stringify(poster))
  const other = db
    .query('SELECT name FROM accounts WHERE id != ? AND (flags & 3) = 0 LIMIT 1')
    .get(id) as { name: string }
  const blocked = await inPage<{ ok: boolean; value?: { blocked: string[] } }>(
    'net/social.ts',
    `return await m.block(${JSON.stringify(other.name)})`,
  )
  check(
    'block',
    blocked.ok && blocked.value?.blocked.includes(other.name) === true,
    JSON.stringify(blocked),
  )
  const unblocked = await inPage<{ ok: boolean; value?: { blocked: string[] } }>(
    'net/social.ts',
    `return await m.unblock(${JSON.stringify(other.name)})`,
  )
  check('unblock', unblocked.ok && unblocked.value?.blocked.length === 0, JSON.stringify(unblocked))
  const rep = await inPage<{ ok: boolean }>(
    'net/social.ts',
    `return await m.report({ name: ${JSON.stringify(other.name)}, reason: 'name' })`,
  )
  check('report', rep.ok, JSON.stringify(rep))
}

async function away(): Promise<void> {
  console.log('\n2. "While you were away" on the hub')
  book('ghost_royalty', 17)
  book('ghost_royalty', 24)
  await page.reload()
  // Past the title card into the saloon (the hub refreshes the profile when it shows).
  await sleep(3000)
  await page.keyboard.press('Enter')
  const notice = page.locator('.ow-feat-notice')
  await notice.waitFor({ timeout: 60_000 })
  const text = (await notice.textContent()) ?? ''
  check(
    'the hub shows the royalty notice',
    text.includes('While you were away') && text.includes('2 duels') && text.includes('41'),
    text,
  )
  await notice.getByRole('button', { name: 'Much obliged' }).click()
  await sleep(1500)
  const me = await inPage<{ ok: boolean; value: { away: { total: number } } }>(
    'net/api.ts',
    'return await m.fetchMe()',
  )
  check(
    'acknowledged: nothing left to report',
    me.ok && me.value.away.total === 0,
    JSON.stringify(me.value.away),
  )
}

async function ranked(): Promise<void> {
  console.log('\n3. Ranked resume through the client RankedSession')
  await page.evaluate(() => {
    ;(globalThis as Record<string, unknown>).owRanked = { log: [] as unknown[] }
  })
  const started = await inPage<{ ok: boolean; error?: string }>(
    'net/ranked.ts',
    `const r = await m.RankedSession.connect('XXXX.DUMMY.TOKEN.XXXX')
     if (!r.ok) return r
     const s = r.value
     const rk = globalThis.owRanked
     rk.s = s
     s.listen({
       message: (msg) => {
         rk.log.push(msg.type === 'result' ? { type: 'result', duel: msg.duel, outcome: msg.outcome } : { type: msg.type, duel: msg.duel })
         if (msg.type === 'call') setTimeout(() => s.shot(msg.duel, 0, 140), (msg.inMs ?? 0) + 140)
       },
       closed: (reason) => rk.log.push({ type: 'closed', reason }),
       reconnecting: (reason) => rk.log.push({ type: 'reconnecting', reason }),
       resumed: (resumed) => rk.log.push({ type: 'resumed', resumed }),
     })
     return { ok: true }`,
  )
  check('RankedSession.connect', started.ok, JSON.stringify(started))
  const log = (): Promise<
    {
      type: string
      duel?: number
      outcome?: string
      resumed?: { level: number; voided: number | null; nextDuel: number }
    }[]
  > => page.evaluate(() => (globalThis as unknown as { owRanked: { log: never[] } }).owRanked.log)
  const waitLog = async (
    pred: (l: Awaited<ReturnType<typeof log>>) => boolean,
    ms = 30_000,
  ): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      // biome-ignore lint/performance/noAwaitInLoops: polling the page
      if (pred(await log())) {
        return true
      }
      await sleep(250)
    }
    return false
  }
  const stage = (duel: number, level: number): Promise<void> =>
    page.evaluate(
      ([d, l]) =>
        (
          globalThis as unknown as { owRanked: { s: { standoff: (d: number, l: number) => void } } }
        ).owRanked.s.standoff(d ?? 0, l ?? 0),
      [duel, level],
    )
  await sleep(1200)
  for (const level of [0, 1]) {
    // biome-ignore lint/performance/noAwaitInLoops: duels happen strictly in order
    await stage(level, level)
    check(
      `outlaw ${level + 1}: won`,
      await waitLog((l) =>
        l.some((m) => m.type === 'result' && m.duel === level && m.outcome === 'win'),
      ),
    )
  }
  await stage(2, 2)
  await sleep(300)
  const source = readFileSync(RELOAD_TRIGGER, 'utf8')
  writeFileSync(RELOAD_TRIGGER, `${source}\n`)
  try {
    check(
      'the client noticed the drop and reconnects',
      await waitLog((l) => l.some((m) => m.type === 'reconnecting'), 20_000),
    )
    check(
      'the client resumed the run from the server',
      await waitLog((l) => l.some((m) => m.type === 'resumed'), 30_000),
    )
  } finally {
    writeFileSync(RELOAD_TRIGGER, source)
  }
  const resumed = (await log()).find((m) => m.type === 'resumed')?.resumed
  check(
    'resumed at outlaw 3 with duel 2 voided',
    resumed?.level === 2 && resumed.voided === 2,
    JSON.stringify(resumed),
  )
  await sleep(5000)
  const next = resumed?.nextDuel ?? 3
  await stage(next, 2)
  check(
    'outlaw 3 won after the resume',
    await waitLog(
      (l) => l.some((m) => m.type === 'result' && m.duel === next && m.outcome === 'win'),
      40_000,
    ),
  )
}

try {
  await sinks()
  await away()
  await ranked()
} finally {
  await browser.close()
}
if (failed() > 0) {
  console.log(`\n${failed()} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)
