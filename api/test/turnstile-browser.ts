/**
 * Real-browser check of the §8 Turnstile gates the client meets without being asked: the first web
 * refresh of the UTC day, and every Frontier lobby join. Not part of `bun test`: it needs a running
 * site and API (dev uses Cloudflare's always-pass test sitekey and secret, so the real widget runs).
 *
 *   PUBLIC_API_URL=http://localhost:8809 bun run dev --port 4369
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8809 --inspector-port 9249 \
 *     --infer-origin-from-routes=false
 *   bun api/test/turnstile-browser.ts [--site http://localhost:4369] [--api-port 8809]
 *
 * A licensed player is seeded with a web refresh token whose account owes today's check. The
 * Frontier page (remote) then has to: refresh (403 `turnstile: required`), get a token from the
 * invisible widget, refresh again (200), and join with a fresh token of its own (201) and a socket.
 */
import process from 'node:process'
import { chromium } from 'playwright'
import { randomToken, sha256Hex } from '../src/auth/crypto.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4369')
const API_PORT = arg('--api-port', '8809')
const DAY_MS = 86_400_000

const db = openLocalD1()
const player = await seedPlayer(db, { name: 'Gatekeeper' })
const refreshToken = randomToken(32)
const now = Date.now()
db.query(
  `INSERT INTO refresh_tokens
     (id, account_id, family_id, token_hash, platform, auth_time, created_at, expires_at)
   VALUES (?, ?, ?, ?, 'web', ?, ?, ?)`,
).run(
  randomToken(),
  player.id,
  randomToken(),
  await sha256Hex(refreshToken),
  now,
  now,
  now + DAY_MS,
)
const day = (): string | null =>
  (
    db.query('SELECT turnstile_day AS d FROM accounts WHERE id = ?').get(player.id) as {
      d: string | null
    }
  ).d
check('the seeded account owes today’s check', day() === null)

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addCookies([
  {
    name: `ow_rt_${API_PORT}`,
    value: refreshToken,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  },
])
await context.addInitScript(
  (hint) => {
    localStorage.setItem('ow-auth-hint', hint)
  },
  JSON.stringify({ accountId: player.id, name: player.name }),
)
const page = await context.newPage()

const refreshes: { status: number; withToken: boolean; turnstile?: unknown }[] = []
const joins: { status: number; withToken: boolean }[] = []
page.on('response', async (res) => {
  const req = res.request()
  if (req.method() !== 'POST') {
    return
  }
  const body = (req.postDataJSON() ?? {}) as { turnstileToken?: unknown }
  const withToken = typeof body.turnstileToken === 'string' && body.turnstileToken.length > 0
  if (res.url().endsWith('/auth/refresh')) {
    const json = (await res.json().catch(() => ({}))) as { turnstile?: unknown }
    refreshes.push({ status: res.status(), withToken, turnstile: json.turnstile })
  } else if (res.url().endsWith('/town/join')) {
    joins.push({ status: res.status(), withToken })
  }
})
const socket = page.waitForEvent('websocket', {
  predicate: (ws) => ws.url().includes('/town/lobby:'),
  timeout: 45_000,
})

await page.goto(`${SITE}/experiments/out-west/frontier/?server=remote&bots=0#tier=legacy`)
const lobbySocket = await socket.catch(() => null)
console.log('refreshes', JSON.stringify(refreshes))
console.log('joins', JSON.stringify(joins))
check(
  'first refresh of the day: 403 turnstile required, no token sent',
  refreshes[0]?.status === 403 && refreshes[0].turnstile === 'required' && !refreshes[0].withToken,
  refreshes,
)
check(
  'the retry carries a widget token and succeeds',
  refreshes[1]?.status === 200 && refreshes[1].withToken,
  refreshes,
)
check('the account is stamped for today', day() === new Date().toISOString().slice(0, 10), day())
check(
  'the lobby join carries its own token and is admitted',
  joins[0]?.status === 201 && joins[0].withToken,
  joins,
)
check('the lobby socket opens', lobbySocket !== null)
await page.locator('.fr-load').waitFor({ state: 'detached', timeout: 30_000 })
await page.screenshot({ path: '.playwright-mcp/ff-turnstile-join.png' })
await browser.close()
db.close()
if (failed() > 0) {
  console.log(`\n${failed()} check(s) failed`)
  process.exit(1)
}
console.log('\nall Turnstile checks passed')
