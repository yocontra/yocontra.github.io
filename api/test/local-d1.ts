/**
 * Shared by the end-to-end scripts in `api/test/`: open the local D1 that `wrangler dev --local`
 * uses, and seed signed-in players straight into it with a real access token.
 */
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { signAccessToken } from '../src/auth/token.ts'
import { nameKey } from '../src/names.ts'
import type { Player } from './duel-client.ts'

const D1_DIR = join(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const SECRET =
  /^AUTH_SECRET=(?<s>.+)$/mu.exec(readFileSync(join(import.meta.dir, '../.dev.vars'), 'utf8'))
    ?.groups?.s ?? ''
const RUN = Date.now().toString(36)

export function openLocalD1(): Database {
  const file = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
  if (file === undefined) {
    throw new Error(`No local D1 in ${D1_DIR}. Apply the migrations first.`)
  }
  const db = new Database(join(D1_DIR, file))
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export interface Seed {
  name: string
  ip?: string
  purse?: number
  /** `profiles.gauntlet_clears`; 7 holds the Bounty Hunt licence. */
  clears?: number
}

let seq = 0
export async function seedPlayer(db: Database, seed: Seed): Promise<Player> {
  const { purse = 500, clears = 7, ip = '10.0.0.1' } = seed
  const id = `e2e${RUN}${++seq}`
  const name = `${seed.name} ${RUN.slice(-4)}${seq}`
  const now = Date.now()
  db.query('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    nameKey(name),
    now,
  )
  db.query(
    `INSERT INTO profiles (account_id, level, xp, prestige, purse, loadout, gauntlet_clears, created_at, updated_at)
     VALUES (?, 1, 0, 0, ?, ?, ?, ?, ?)`,
  ).run(id, purse, JSON.stringify(DEFAULT_LOADOUT), clears, now, now)
  db.query(
    `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
     VALUES (?, ?, 0, ?, 'start_grant', 'e2e', ?, 'e2e', ?)`,
  ).run(id, purse, purse, `e2e:${id}`, now)
  const { token } = await signAccessToken(SECRET, {
    accountId: id,
    name,
    sid: `e2e-${id}`,
    platform: 'web',
    authTime: now,
  })
  return { id, name, token, ip }
}

let failures = 0
export function check(label: string, ok: boolean, detail: unknown = ''): void {
  // biome-ignore lint/suspicious/noConsole: a CLI harness reports to the terminal
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) {
    failures++
  }
}

export const failed = (): number => failures
