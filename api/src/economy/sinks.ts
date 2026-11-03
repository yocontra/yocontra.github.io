/**
 * The shared money sinks (§5): dye jobs, name changes and "Buy the house a round". Each is one D1
 * batch: the guarded state change, then the ledger debit. An overdraft fails the purse CHECK, and a
 * guarded UPDATE that changed nothing (a race, a stale request) fails `batch_guard`; either rolls
 * the whole batch back, so money and state never disagree.
 */
import type { ChalkboardLine } from '../../../src/experiments/out-west/contract/social.ts'
import type { ItemId } from '../../../src/experiments/out-west/data/catalog.ts'
import type { DyeId } from '../../../src/experiments/out-west/data/dye.ts'
import { isDyeId } from '../../../src/experiments/out-west/data/dye.ts'
import {
  CHALKBOARD_SIZE,
  HOUSE_ROUND_PRICE,
  NAME_CHANGE_COOLDOWN_MS,
  NAME_CHANGE_PRICE,
  NAME_HOLD_MS,
} from '../../../src/experiments/out-west/data/sinks.ts'
import type { Env } from '../env.ts'
import { ledgerStatements } from './ledger.ts'

/** Fails the batch unless the statement just before it changed exactly one row. */
export function guardStatements(env: Env): D1PreparedStatement[] {
  return [
    env.DB.prepare('INSERT INTO batch_guard (ok) VALUES (changes())'),
    env.DB.prepare('DELETE FROM batch_guard'),
  ]
}

// --- dye -----------------------------------------------------------------------------------------

/** Every dyed item the account owns. */
export async function dyesOf(env: Env, accountId: string): Promise<Partial<Record<ItemId, DyeId>>> {
  const { results } = await env.DB.prepare(
    'SELECT item_id, dye FROM inventory WHERE account_id = ? AND dye IS NOT NULL',
  )
    .bind(accountId)
    .all<{ item_id: ItemId; dye: string }>()
  const out: Partial<Record<ItemId, DyeId>> = {}
  for (const r of results) {
    if (isDyeId(r.dye) && r.dye !== 'natural') {
      out[r.item_id] = r.dye
    }
  }
  return out
}

export function dyeStatements(
  env: Env,
  job: {
    accountId: string
    itemId: ItemId
    dye: DyeId
    current: DyeId | null
    price: number
    requestId: string
  },
): D1PreparedStatement[] {
  const next = job.dye === 'natural' ? null : job.dye
  return [
    env.DB.prepare(
      `UPDATE inventory SET dye = ?3 WHERE account_id = ?1 AND item_id = ?2
         AND COALESCE(dye, 'natural') = ?4`,
    ).bind(job.accountId, job.itemId, next, job.current ?? 'natural'),
    ...guardStatements(env),
    ...(job.price > 0
      ? ledgerStatements(env, `dye:${job.accountId}:${job.requestId}`, [
          {
            accountId: job.accountId,
            kind: 'dye_job',
            amount: -job.price,
            ref: `${job.itemId}:${job.dye}`,
          },
        ])
      : []),
  ]
}

// --- name change ---------------------------------------------------------------------------------

export type NameRefusal = 'taken' | 'same' | 'cooldown'

/** Why the account can't take `newKey` now, or null. */
export async function nameRefusal(
  env: Env,
  opts: { accountId: string; currentKey: string; newKey: string; changedAt: number | null },
  now = Date.now(),
): Promise<{ reason: NameRefusal; retryAt?: number } | null> {
  if (opts.newKey === opts.currentKey) {
    return { reason: 'same' }
  }
  if (opts.changedAt !== null && opts.changedAt + NAME_CHANGE_COOLDOWN_MS > now) {
    return { reason: 'cooldown', retryAt: opts.changedAt + NAME_CHANGE_COOLDOWN_MS }
  }
  const taken = await env.DB.prepare(
    `SELECT 1 AS taken FROM accounts WHERE name_key = ?1
     UNION ALL SELECT 1 FROM name_tombstones WHERE name_key = ?1 AND released_at > ?2
     UNION ALL SELECT 1 FROM name_holds WHERE name_key = ?1 AND released_at > ?2 AND account_id != ?3
     UNION ALL SELECT 1 FROM name_reservations WHERE name_key = ?1 AND expires_at > ?2
     LIMIT 1`,
  )
    .bind(opts.newKey, now, opts.accountId)
    .first<{ taken: number }>()
  return taken ? { reason: 'taken' } : null
}

export function nameChangeStatements(
  env: Env,
  change: {
    accountId: string
    oldName: string
    oldKey: string
    newName: string
    newKey: string
    changedAt: number | null
  },
  now = Date.now(),
): D1PreparedStatement[] {
  const key = `name:${change.accountId}:${change.changedAt ?? 0}`
  return [
    // Guarded on the name and cooldown we checked, so a concurrent change can't slip in. The
    // UNIQUE name_key fails the batch if somebody took the name meanwhile.
    env.DB.prepare(
      `UPDATE accounts SET name = ?2, name_key = ?3, name_changed_at = ?4
       WHERE id = ?1 AND name_key = ?5 AND COALESCE(name_changed_at, 0) = ?6
         AND NOT EXISTS (SELECT 1 FROM name_tombstones WHERE name_key = ?3 AND released_at > ?4)
         AND NOT EXISTS (SELECT 1 FROM name_holds
                          WHERE name_key = ?3 AND released_at > ?4 AND account_id != ?1)`,
    ).bind(
      change.accountId,
      change.newName,
      change.newKey,
      now,
      change.oldKey,
      change.changedAt ?? 0,
    ),
    ...guardStatements(env),
    env.DB.prepare(
      `INSERT INTO name_changes (account_id, old_name, new_name, idem_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(change.accountId, change.oldName, change.newName, key, now),
    // The old name is held for this account; reclaiming a held name releases that hold.
    env.DB.prepare('DELETE FROM name_holds WHERE name_key = ? AND account_id = ?').bind(
      change.newKey,
      change.accountId,
    ),
    env.DB.prepare(
      `INSERT INTO name_holds (name_key, account_id, released_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name_key) DO UPDATE SET account_id = ?2, released_at = ?3`,
    ).bind(change.oldKey, change.accountId, now + NAME_HOLD_MS),
    env.DB.prepare('UPDATE ghost_profiles SET name = ? WHERE account_id = ?').bind(
      change.newName,
      change.accountId,
    ),
    ...ledgerStatements(env, key, [
      {
        accountId: change.accountId,
        kind: 'name_change',
        amount: -NAME_CHANGE_PRICE,
        ref: change.newName,
      },
    ]),
  ]
}

// --- a round for the house -------------------------------------------------------------------

export function roundStatements(
  env: Env,
  round: { accountId: string; name: string; requestId: string },
  now = Date.now(),
): D1PreparedStatement[] {
  const key = `round:${round.accountId}:${round.requestId}`
  return [
    ...ledgerStatements(env, key, [
      {
        accountId: round.accountId,
        kind: 'house_round',
        amount: -HOUSE_ROUND_PRICE,
        ref: 'saloon',
      },
    ]),
    env.DB.prepare(
      `INSERT INTO house_rounds (account_id, name, idem_key, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (idem_key) DO NOTHING`,
    ).bind(round.accountId, round.name, key, now),
  ]
}

export async function chalkboard(env: Env): Promise<ChalkboardLine[]> {
  const { results } = await env.DB.prepare(
    'SELECT name, created_at FROM house_rounds ORDER BY id DESC LIMIT ?',
  )
    .bind(CHALKBOARD_SIZE)
    .all<{ name: string; created_at: number }>()
  return results.map((r) => ({ name: r.name, at: r.created_at }))
}

const REQUEST_ID = /^[\w-]{8,64}$/u

/** The client's nonce if it sent a sane one, else a fresh one. */
export const requestIdOf = (value: unknown): string =>
  typeof value === 'string' && REQUEST_ID.test(value) ? value : crypto.randomUUID()
