/**
 * End-to-end check for "a gauntlet first-clear credit went missing": a signed-in ranked run against
 * a running `wrangler dev`, where the third first clear's D1 write fails (the local D1 file is
 * write-locked from outside, a stand-in for a transient D1 error) and the Worker is reloaded while
 * the credit is still owed (a stand-in for a deploy resetting the Durable Object). The credit must
 * still land, exactly once.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8797 --inspector-port 9237
 *   bun api/test/ranked-credit-e2e.ts [http://localhost:8797]
 *
 * Not part of `bun test`. Seeds its own account straight into the local D1.
 */
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { signAccessToken } from '../src/auth/token.ts'
import { nameKey } from '../src/names.ts'

const BASE = process.argv[2] ?? 'http://localhost:8797'
const ORIGIN = 'http://localhost:4348'
const D1_DIR = join(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const SECRET =
  /^AUTH_SECRET=(?<s>.+)$/mu.exec(readFileSync(join(import.meta.dir, '../.dev.vars'), 'utf8'))
    ?.groups?.s ?? ''
/** Any Worker source: touching it makes `wrangler dev` rebuild and reset every Durable Object. */
const RELOAD_TRIGGER = join(import.meta.dir, '../src/tuning.ts')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function openD1(): Database {
  const file = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
  if (!file) {
    throw new Error(`No local D1 in ${D1_DIR}. Apply the migrations first.`)
  }
  const db = new Database(join(D1_DIR, file))
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

const db = openD1()
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) {
    failures++
  }
}

async function seed(): Promise<{ id: string; token: string }> {
  const id = `rc${Date.now().toString(36)}`
  const name = `Credit ${id.slice(-5)}`
  const now = Date.now()
  db.query('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    nameKey(name),
    now,
  )
  db.query(
    `INSERT INTO profiles (account_id, level, xp, prestige, purse, loadout, gauntlet_clears, created_at, updated_at)
     VALUES (?, 1, 0, 0, 250, ?, 0, ?, ?)`,
  ).run(id, JSON.stringify(DEFAULT_LOADOUT), now, now)
  db.query(
    `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
     VALUES (?, 250, 0, 250, 'start_grant', 'e2e', ?, 'e2e', ?)`,
  ).run(id, `e2e:${id}`, now)
  const { token } = await signAccessToken(SECRET, {
    accountId: id,
    name,
    sid: `e2e-${id}`,
    platform: 'web',
    authTime: now,
  })
  return { id, token }
}

interface Msg {
  type: string
  duel?: number
  outcome?: string
  n?: number
  /** `call`: present it this long after it arrives (the server sends it ahead). */
  inMs?: number
}

async function main(): Promise<void> {
  const player = await seed()
  const res = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Authorization: `Bearer ${player.token}`,
    },
    body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
  })
  const { wsUrl } = (await res.json()) as { wsUrl: string }
  const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } } as unknown as string[])
  const inbox: Msg[] = []
  let wake: (() => void) | null = null
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as Msg
    if (m.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', n: m.n }))
      return
    }
    inbox.push(m)
    wake?.()
  })
  const nap = (): Promise<void> =>
    new Promise<void>((r) => {
      wake = r
      setTimeout(r, 200)
    })
  const next = async (type: string, timeoutMs = 20_000): Promise<Msg> => {
    const until = Date.now() + timeoutMs
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type || m.type === 'error')
      if (i >= 0) {
        const [m] = inbox.splice(i, 1)
        if (m?.type === 'error') {
          throw new Error(`server error: ${JSON.stringify(m)}`)
        }
        return m as Msg
      }
      if (Date.now() > until) {
        throw new Error(`timed out waiting for ${type}`)
      }
      await nap()
    }
  }
  await next('hello')
  await sleep(1500) // a few pings, so the server has an RTT

  let lock: Database | null = null
  for (const level of [0, 1, 2]) {
    if (level === 2) {
      // the third first clear: D1 can't be written until we let go
      lock = new Database(db.filename)
      lock.exec('BEGIN EXCLUSIVE')
    }
    ws.send(JSON.stringify({ type: 'standoff', duel: level, level }))
    const call = await next('call')
    await sleep((call.inMs ?? 0) + 140)
    ws.send(JSON.stringify({ type: 'shot', duel: level, target: 0, localMs: 140 }))
    const result = await next('result')
    check(`outlaw ${level + 1}: won`, result.outcome === 'win', result)
    await sleep(800)
  }
  const clearsNow = (): { clears: number; xp: number } =>
    db
      .query('SELECT gauntlet_clears AS clears, xp FROM profiles WHERE account_id = ?')
      .get(player.id) as { clears: number; xp: number }

  // The third credit is owed. Reset the Worker (and so the DuelSession) while it is.
  utimesSync(RELOAD_TRIGGER, new Date(), new Date())
  await sleep(4000)
  lock?.exec('COMMIT')
  lock?.close()
  check('before the retry: the first two clears only', clearsNow().clears === 0b011, clearsNow())
  // the retry alarm (2 s, then 4 s, ... or the 30 s safety alarm) picks the job up after the reset
  const deadline = Date.now() + 45_000
  while (clearsNow().clears !== 0b111 && Date.now() < deadline) {
    await sleep(500)
  }
  const after = clearsNow()
  check('after the reset: the third first clear landed', after.clears === 0b111, after)
  check('paid exactly once: 40 + 55 + 70 XP', after.xp === 165, after)
  const rows = db
    .query(
      "SELECT idem_key FROM ledger WHERE account_id = ? AND kind = 'gauntlet_clear' ORDER BY id",
    )
    .all(player.id) as { idem_key: string }[]
  check(
    'three first-clear rows, no repeat rows',
    rows.length === 3 && rows.every((r) => r.idem_key.startsWith('gauntlet:first:')),
    rows,
  )
  ws.close()
}

await main()
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
