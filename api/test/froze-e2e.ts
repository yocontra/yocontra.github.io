/**
 * End-to-end check for the standoff ledger kinds: two signed-in players queue for Bounty Hunt
 * against a running `wrangler dev`, neither fires, and both freeze. Their XP-only entry must be
 * booked as `duel_froze` (the hub's "Standoff: both froze"), never `duel_win`, and read back through
 * `GET /me/ledger`.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8797 --inspector-port 9237
 *   bun api/test/froze-e2e.ts http://localhost:8797 [--expect duel_win]
 *
 * `--expect` names the kind to require instead (e.g. to record what older code booked).
 * Not part of `bun test`. Seeds its own accounts straight into the local D1.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { signAccessToken } from '../src/auth/token.ts'
import { nameKey } from '../src/names.ts'
import { BASE, Client, ORIGIN, type Player } from './duel-client.ts'

const D1_DIR = join(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const SECRET =
  /^AUTH_SECRET=(?<s>.+)$/mu.exec(readFileSync(join(import.meta.dir, '../.dev.vars'), 'utf8'))
    ?.groups?.s ?? ''
const flag = process.argv.indexOf('--expect')
const EXPECT = flag >= 0 ? (process.argv[flag + 1] ?? 'duel_froze') : 'duel_froze'
const RUN = Date.now().toString(36)

const file = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
if (file === undefined) {
  throw new Error(`No local D1 in ${D1_DIR}. Apply the migrations first.`)
}
const db = new Database(join(D1_DIR, file))
db.exec('PRAGMA busy_timeout = 5000')

let seq = 0
async function seedPlayer(name: string, ip: string): Promise<Player> {
  const id = `fz${RUN}${++seq}`
  const display = `${name} ${RUN.slice(-4)}${seq}`
  const now = Date.now()
  db.query('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    display,
    nameKey(display),
    now,
  )
  db.query(
    `INSERT INTO profiles (account_id, level, xp, prestige, purse, loadout, gauntlet_clears, created_at, updated_at)
     VALUES (?, 1, 0, 0, 500, ?, 7, ?, ?)`,
  ).run(id, JSON.stringify(DEFAULT_LOADOUT), now, now)
  db.query(
    `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
     VALUES (?, 500, 0, 500, 'start_grant', 'e2e', ?, 'e2e', ?)`,
  ).run(id, `e2e:${id}`, now)
  const { token } = await signAccessToken(SECRET, {
    accountId: id,
    name: display,
    sid: `e2e-${id}`,
    platform: 'web',
    authTime: now,
  })
  return { id, name: display, token, ip }
}

let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) {
    failures++
  }
}

const a = new Client(await seedPlayer('Statue', '10.71.0.1'), { reactMs: null })
const b = new Client(await seedPlayer('Stone', '10.72.0.1'), { reactMs: null })
const [ua, ub] = await Promise.all([a.queue(), b.queue()])
if (!(ua && ub)) {
  throw new Error('queue failed')
}
a.join(ua)
b.join(ub)
await a.waitFor(() => a.results.length >= 1, 60_000)
const result = a.results[0]
check('both froze', result?.outcome === 'froze', result)
check('XP only on the results sheet', result?.you?.delta === 0 && result.you.xp > 0, result?.you)

const res = await fetch(`${BASE}/me/ledger?limit=5`, {
  headers: { Origin: ORIGIN, Authorization: `Bearer ${a.player.token}` },
})
const { entries } = (await res.json()) as {
  entries: { kind: string; amount: number; xp: number }[]
}
const newest = entries[0]
check(`GET /me/ledger books it as ${EXPECT}`, newest?.kind === EXPECT, entries)
check('with $0 and the XP', newest?.amount === 0 && newest.xp > 0, newest)
process.exit(failures > 0 ? 1 : 0)
