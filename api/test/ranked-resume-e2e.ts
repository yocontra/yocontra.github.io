/**
 * End-to-end check for ranked resume, the ranked budget gate and the gauntlet reward items, against
 * a running `wrangler dev`:
 *
 * 1. Over budget, `POST /sessions` is refused with 503 `over_budget`.
 * 2. A signed-in run wins outlaws 1–2, drops mid-duel on outlaw 3, and resumes with its token: the
 *    duel in progress is voided, and the run continues from outlaw 3 with the same purse.
 * 3. A bad token is refused (403); a second plain connect is refused (409).
 * 4. Mid-duel on outlaw 5 the Worker is reloaded (every Durable Object restarts); the run resumes
 *    from storage.
 * 5. The run is cleared to the end without drawing early: every first clear is paid exactly once
 *    (never for a voided duel), and the account gets Hardin's Pair and the Midnight frame.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8799 --inspector-port 9239 \
 *     --infer-origin-from-routes=false
 *   bun api/test/ranked-resume-e2e.ts [http://localhost:8799]
 *
 * Not part of `bun test`. Seeds its own account straight into the local D1.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: duels happen strictly in order
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type {
  RankedResumed,
  RankedSessionResponse,
} from '../../src/experiments/out-west/contract/ranked.ts'
import { gauntletFirstClearXp } from '../../src/experiments/out-west/data/progression.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const BASE = process.argv[2] ?? 'http://localhost:8799'
const ORIGIN = 'http://localhost:4354'
const RELOAD_TRIGGER = join(import.meta.dir, '../src/tuning.ts')
const LAST = 16
/** Outlaw 15 (Curly Bill) has a rooftop rifleman first: two targets. */
const TARGETS: Readonly<Record<number, number>> = { 15: 2 }

/**
 * Makes `wrangler dev` rebuild, which restarts every Durable Object. Its watcher skips a bare
 * touch, so a trailing newline is added to a Worker source; call the result to take it off again
 * (a second rebuild).
 */
function reloadWorker(): () => void {
  const source = readFileSync(RELOAD_TRIGGER, 'utf8')
  writeFileSync(RELOAD_TRIGGER, `${source}\n`)
  return () => writeFileSync(RELOAD_TRIGGER, source)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const db = openLocalD1()

interface Msg {
  type: string
  duel?: number
  outcome?: string
  n?: number
  purse?: number
  total?: number
  resumed?: RankedResumed
}

/** One socket to the run, with an inbox. */
class Conn {
  readonly ws: WebSocket
  private readonly inbox: Msg[] = []
  private wake: (() => void) | null = null

  constructor(url: string) {
    this.ws = new WebSocket(url, { headers: { Origin: ORIGIN } } as unknown as string[])
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Msg
      if (m.type === 'ping') {
        this.ws.send(JSON.stringify({ type: 'pong', n: m.n }))
        return
      }
      this.inbox.push(m)
      this.wake?.()
    })
    this.ws.addEventListener('close', () => this.wake?.())
  }

  isClosed(): boolean {
    return this.ws.readyState === WebSocket.CLOSED
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m))
  }

  async next(type: string, timeoutMs = 20_000): Promise<Msg> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type || m.type === 'error')
      if (i >= 0) {
        const [m] = this.inbox.splice(i, 1)
        if (m?.type === 'error') {
          throw new Error(`server error: ${JSON.stringify(m)}`)
        }
        return m as Msg
      }
      if (Date.now() > until) {
        throw new Error(`timed out waiting for ${type}`)
      }
      await new Promise<void>((r) => {
        this.wake = r
        setTimeout(r, 200)
      })
    }
  }

  /** Wins outlaw `level` as duel `duel`: waits for the call, fires every target at 140 ms. */
  async win(duel: number, level: number): Promise<Msg> {
    this.send({ type: 'standoff', duel, level })
    await this.next('call', 30_000)
    await sleep(140)
    for (let target = 0; target < (TARGETS[level] ?? 1); target++) {
      this.send({ type: 'shot', duel, target, localMs: 140 })
      await sleep(30)
    }
    return this.next('result')
  }
}

const WS_SCHEME = /^ws/u

/** A random Sec-WebSocket-Key (16 bytes, base64). */
const wsKey = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))

async function upgradeStatus(url: string): Promise<number> {
  const res = await fetch(url.replace(WS_SCHEME, 'http'), {
    headers: {
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': wsKey(),
    },
  })
  return res.status
}

function newSession(token: string): Promise<Response> {
  return fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
  })
}

async function budgetGate(token: string): Promise<void> {
  const month = new Date().toISOString().slice(0, 7)
  const before = db
    .query("SELECT amount FROM usage WHERE month = ? AND metric = 'duel_seconds'")
    .get(month) as { amount: number } | null
  db.query(
    `INSERT INTO usage (month, metric, amount) VALUES (?, 'duel_seconds', 700000)
     ON CONFLICT (month, metric) DO UPDATE SET amount = 700000`,
  ).run(month)
  const res = await newSession(token)
  const body = (await res.json()) as { reason?: string; error?: string }
  check('over budget: POST /sessions is refused with 503', res.status === 503, res.status)
  check(
    'with reason over_budget and a message',
    body.reason === 'over_budget' && Boolean(body.error),
    body,
  )
  db.query("UPDATE usage SET amount = ? WHERE month = ? AND metric = 'duel_seconds'").run(
    before?.amount ?? 0,
    month,
  )
}

async function main(): Promise<void> {
  const player = await seedPlayer(db, { name: 'Resumer', clears: 0, purse: 250 })
  await budgetGate(player.token)

  const res = await newSession(player.token)
  const session = (await res.json()) as RankedSessionResponse
  check(
    'POST /sessions returns a resume token',
    res.status === 201 && session.resumeToken.length === 64,
    session,
  )
  const resumeUrl = (token: string) => `${session.wsUrl}?resume=${encodeURIComponent(token)}`

  let conn = new Conn(session.wsUrl)
  await conn.next('hello')
  await sleep(1200)
  let purse = 0
  for (const level of [0, 1]) {
    const r = await conn.win(level, level)
    check(`outlaw ${level + 1}: won`, r.outcome === 'win', r)
    purse = r.purse ?? 0
  }

  // Drop mid-duel on outlaw 3 (duel 2): the standoff is running, nobody has fired.
  conn.send({ type: 'standoff', duel: 2, level: 2 })
  await sleep(300)
  conn.ws.close()
  await sleep(300)
  check(
    'a bad resume token is refused (403)',
    (await upgradeStatus(resumeUrl('00'.repeat(32)))) === 403,
  )
  check('a second plain connect is refused (409)', (await upgradeStatus(session.wsUrl)) === 409)

  conn = new Conn(resumeUrl(session.resumeToken))
  let hello = await conn.next('hello')
  check(
    'resumed at outlaw 3, same purse, duel 2 voided',
    hello.resumed?.level === 2 &&
      hello.resumed.purse === purse &&
      hello.resumed.voided === 2 &&
      hello.resumed.nextDuel === 3,
    hello.resumed,
  )
  await sleep(600)
  let duel = hello.resumed?.nextDuel ?? 3
  for (const level of [2, 3]) {
    const r = await conn.win(duel++, level)
    check(`outlaw ${level + 1}: won after the resume`, r.outcome === 'win', r)
  }

  // A restart mid-duel on outlaw 5: reload the Worker, every Durable Object starts afresh.
  conn.send({ type: 'standoff', duel, level: 4 })
  await sleep(300)
  const restore = reloadWorker()
  const until = Date.now() + 15_000
  while (!conn.isClosed() && Date.now() < until) {
    await sleep(200)
  }
  check('the reload dropped the socket', conn.isClosed())
  // Put the source back now, and let that rebuild settle too, before resuming (still in the window).
  restore()
  await sleep(5000)
  let resumed: Msg | null = null
  for (const backoff of [250, 500, 1000, 2000, 4000, 4000, 4000]) {
    await sleep(backoff)
    try {
      conn = new Conn(resumeUrl(session.resumeToken))
      resumed = await conn.next('hello', 5000)
      break
    } catch {
      // The Worker is still rebuilding; try again.
    }
  }
  hello = resumed ?? { type: 'none' }
  check(
    'after the restart: resumed from storage at outlaw 5, the cut-off duel voided',
    hello.resumed?.level === 4 && hello.resumed.voided === duel,
    hello.resumed,
  )
  duel = hello.resumed?.nextDuel ?? duel + 1
  await sleep(600)

  // Clear the rest, the boss twice (his first draw only wounds him).
  let level = 4
  let phaseTwo = false
  while (level <= LAST) {
    const r = await conn.win(duel++, level)
    if (r.outcome !== 'win') {
      check(`outlaw ${level + 1}: won`, false, r)
      return
    }
    if (level === LAST && !phaseTwo) {
      phaseTwo = true
      continue
    }
    level++
  }
  conn.send({ type: 'finish', name: 'ignored for accounts' })
  const final = await conn.next('final')
  check('the run is recorded', (final.total ?? 0) > 0, final)

  // Credits land through the outbox; give it a moment.
  const deadline = Date.now() + 20_000
  const clears = () =>
    db
      .query('SELECT gauntlet_clears AS c, xp FROM profiles WHERE account_id = ?')
      .get(player.id) as {
      c: number
      xp: number
    }
  while (clears().c !== 0x1_ff_ff && Date.now() < deadline) {
    await sleep(500)
  }
  const after = clears()
  check('every outlaw first-cleared', after.c === 0x1_ff_ff, after)
  const rows = db
    .query("SELECT idem_key FROM ledger WHERE account_id = ? AND kind = 'gauntlet_clear'")
    .all(player.id) as { idem_key: string }[]
  check(
    '17 first-clear rows: paid once each, nothing for the voided duels',
    rows.length === 17,
    rows.length,
  )
  const xp = Array.from({ length: 17 }, (_, i) => gauntletFirstClearXp(i)).reduce(
    (a, b) => a + b,
    0,
  )
  check(`gauntlet XP is exactly ${xp}`, after.xp === xp, after)
  const items = (
    db.query('SELECT item_id FROM inventory WHERE account_id = ?').all(player.id) as {
      item_id: string
    }[]
  ).map((r) => r.item_id)
  check("Hardin's Pair granted", items.includes('gun.hardins-pair'), items)
  check('the Midnight frame granted (no cowardice)', items.includes('frame.midnight'), items)
  check(
    'the finished run cannot be resumed (410)',
    (await upgradeStatus(resumeUrl(session.resumeToken))) === 410,
  )
}

await main()
if (failed() > 0) {
  console.log(`${failed()} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
process.exit(0)
