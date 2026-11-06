/**
 * Real-browser regression for "a signed-in player lost their session": a page reload that drops a
 * refresh response after the server rotated the token, plus a second tab (the `/auth/app` handoff
 * page) following the sign-in. Drives Chrome over the DevTools protocol with a virtual passkey
 * authenticator (`WebAuthn.enable` + `addVirtualAuthenticator`). Not part of `bun test`: it needs a
 * running site and API.
 *
 *   PUBLIC_API_URL=http://localhost:8797 bun run dev --port 4348
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8797 --inspector-port 9237
 *   bun api/test/auth-reload-browser.ts [--site http://localhost:4348] [--api-port 8797]
 *
 * Steps:
 * 1. Sign up with the virtual passkey; note the refresh cookie.
 * 2. Reload. Pause the boot refresh *after* the server answered (so it has rotated), and reload again
 *    before the browser sees the response: the rotated cookie is lost, the old one stays.
 * 3. Hold the next boot refresh for longer than the 10 s race grace, then let it through. Before the
 *    fix this was theft detection (401, cookie cleared, family revoked); now it is a replay.
 * 4. Open the handoff page in a second tab and count refreshes for a few seconds: one, not a loop.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4348')
const API_PORT = arg('--api-port', '8797')
const COOKIE = `ow_rt_${API_PORT}`
const DEBUG_PORT = Number(arg('--debug-port', '9347'))
const GRACE_HOLD_MS = 11_000
/** Skip the reload steps (2 and 3) and only check the two-tab sign-in. */
const TABS_ONLY = process.argv.includes('--tabs-only')

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
]

type Json = Record<string, unknown>
interface CdpEvent {
  method: string
  params: Json
  sessionId?: string
}

class Cdp {
  private readonly ws: WebSocket
  private seq = 0
  private readonly pending = new Map<number, (v: Json) => void>()
  private readonly listeners = new Set<(e: CdpEvent) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Json
      if (typeof m.id === 'number') {
        if (m.error) {
          console.error('cdp error', m.error)
        }
        this.pending.get(m.id)?.((m.result as Json | undefined) ?? {})
        this.pending.delete(m.id)
      } else {
        for (const l of this.listeners) {
          l(m as unknown as CdpEvent)
        }
      }
    })
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))
    return new Cdp(ws)
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((r) => this.pending.set(id, r))
  }

  on(cb: (e: CdpEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  wait(pred: (e: CdpEvent) => boolean, timeoutMs = 20_000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('timed out waiting for a CDP event'))
      }, timeoutMs)
      const off = this.on((e) => {
        if (pred(e)) {
          clearTimeout(timer)
          off()
          resolve(e)
        }
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
  if (!ok) {
    failures++
  }
}

async function main(): Promise<void> {
  const chrome = CHROMES.find((c) => existsSync(c))
  if (!chrome) {
    throw new Error('no Chrome found')
  }
  const profile = mkdtempSync(join(tmpdir(), 'ow-auth-'))
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  try {
    let version: Json | null = null
    for (let i = 0; i < 50 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
        .then((r) => r.json() as Promise<Json>)
        .catch(() => null)
      if (!version) {
        await sleep(100)
      }
    }
    const cdp = await Cdp.open(String(version?.webSocketDebuggerUrl))
    await run(cdp)
    cdp.close()
  } finally {
    proc.kill()
  }
}

async function attach(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const s = String(sessionId)
  await cdp.send('Page.enable', {}, s)
  await cdp.send('Network.enable', {}, s)
  await cdp.send('Runtime.enable', {}, s)
  await cdp.send('WebAuthn.enable', {}, s)
  await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    s,
  )
  if (url) {
    await navigate(cdp, s, url)
  }
  return s
}

async function navigate(cdp: Cdp, s: string, url: string): Promise<void> {
  const loaded = cdp.wait((e) => e.sessionId === s && e.method === 'Page.loadEventFired', 60_000)
  await cdp.send('Page.navigate', { url }, s)
  await loaded
}

async function evaluate(cdp: Cdp, s: string, expression: string): Promise<unknown> {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    s,
  )
  return (r.result as Json | undefined)?.value
}

async function refreshCookie(cdp: Cdp, s: string): Promise<string | null> {
  const r = await cdp.send('Network.getCookies', { urls: [`http://localhost:${API_PORT}/`] }, s)
  const all = (r.cookies as { name: string; value: string }[] | undefined) ?? []
  return all.find((c) => c.name === COOKIE)?.value ?? null
}

/** The next paused `/auth/refresh` POST; CORS preflights are let through. */
async function pausedPost(cdp: Cdp, s: string): Promise<CdpEvent> {
  for (;;) {
    const e = await cdp.wait((x) => x.sessionId === s && x.method === 'Fetch.requestPaused', 60_000)
    if ((e.params.request as Json).method === 'POST') {
      return e
    }
    await cdp.send('Fetch.continueRequest', { requestId: e.params.requestId }, s)
  }
}

const AUTH = `import('/src/experiments/out-west/net/auth.ts')`

async function run(cdp: Cdp): Promise<void> {
  const page = `${SITE}/experiments/out-west/`
  const a = await attach(cdp, page)

  // 1. sign up
  const name = `Reload ${Math.floor(Math.random() * 1e6)}`
  const up = (await evaluate(
    cdp,
    a,
    `${AUTH}.then(m => m.signUp(${JSON.stringify(name)})).then(r => JSON.stringify(r))`,
  )) as string
  check('signed up with the virtual passkey', up.includes('"ok":true'), up)
  const original = await refreshCookie(cdp, a)
  check('refresh cookie set', original !== null)

  if (!TABS_ONLY) {
    // 2. reload while the boot refresh's response is held, after the server has rotated
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*/auth/refresh*', requestStage: 'Response' }] },
      a,
    )
    const paused = pausedPost(cdp, a)
    await cdp.send('Page.reload', {}, a)
    const rotated = await paused
    // Chrome's network service stores Set-Cookie as soon as the headers arrive, even while the
    // response is paused here. A real reload loses the cookie when it cancels the request between
    // the server's commit and the headers arriving; reproduce that end state by putting the old
    // cookie back, then aborting the response.
    await cdp.send(
      'Network.setCookie',
      {
        name: COOKIE,
        value: original,
        url: `http://localhost:${API_PORT}/`,
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      },
      a,
    )
    await cdp.send(
      'Fetch.failRequest',
      { requestId: rotated.params.requestId, errorReason: 'Aborted' },
      a,
    )
    check(
      'paused the refresh POST after the server answered',
      rotated.params.responseStatusCode === 200,
      String(rotated.params.responseStatusCode),
    )
    // the server answered (and rotated); reload before the browser processes the response
    const reloaded = cdp.wait(
      (e) => e.sessionId === a && e.method === 'Page.loadEventFired',
      60_000,
    )
    // (re-enabling swaps the patterns and leaves the paused response paused; disabling would deliver it)
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*/auth/refresh*', requestStage: 'Request' }] },
      a,
    )
    const held = pausedPost(cdp, a)
    await cdp.send('Page.reload', {}, a)
    const after = await refreshCookie(cdp, a)
    check('the rotated cookie was lost with the reload', after === original)

    // 3. the next boot refresh presents the old cookie after the race grace
    const next = await held
    check(
      'held the reloaded page’s boot refresh',
      (next.params.request as Json).method === 'POST',
      String((next.params.request as Json).method),
    )
    await reloaded
    await sleep(GRACE_HOLD_MS)
    const responded = cdp.wait(
      (e) =>
        e.sessionId === a &&
        e.method === 'Network.responseReceived' &&
        e.params.type !== 'Preflight' &&
        String((e.params.response as Json).url).endsWith('/auth/refresh'),
    )
    await cdp.send('Fetch.continueRequest', { requestId: next.params.requestId }, a)
    await cdp.send('Fetch.disable', {}, a)
    const res = await responded
    const status = Number((res.params.response as Json).status)
    check(
      'old cookie past the grace is replayed, not treated as theft',
      status === 200,
      `${status}`,
    )
    await sleep(500)
    const player = (await evaluate(
      cdp,
      a,
      `${AUTH}.then(m => m.restoreSession()).then(p => p && p.name)`,
    )) as string | null
    check('still signed in after the reloads', player === name, String(player))
    const successor = await refreshCookie(cdp, a)
    check('the cookie moved on to the successor', successor !== null && successor !== original)
    const token = (await evaluate(
      cdp,
      a,
      `${AUTH}.then(async m => { const r = await fetch(m.API_URL + '/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-OW-Client': 'web' }, body: '{}' }); return r.status })`,
    )) as number
    check('and that successor refreshes normally', token === 200, String(token))
  }

  // 4. a second tab (the app handoff page) follows the sign-in without a refresh loop
  let refreshes = 0
  const off = cdp.on((e) => {
    if (
      e.method === 'Network.requestWillBeSent' &&
      (e.params.request as Json).method === 'POST' &&
      String((e.params.request as Json).url).endsWith('/auth/refresh')
    ) {
      refreshes++
      console.log(`  refresh from the ${e.sessionId === a ? 'game' : 'handoff'} tab`)
    }
  })
  const handoff = await attach(cdp, '')
  await navigate(
    cdp,
    handoff,
    `${SITE}/experiments/out-west/auth/app?challenge=${'a'.repeat(43)}&state=s&redirect_uri=outwest%3A%2F%2Fauth`,
  )
  await sleep(5000)
  off()
  check('two tabs: no refresh ping-pong', refreshes <= 2, `${refreshes} refreshes in 5 s`)
  const still = (await evaluate(
    cdp,
    a,
    `${AUTH}.then(m => m.getAccessToken()).then(t => t !== null)`,
  )) as boolean
  check('first tab still has a token', still)
}

await main()
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
