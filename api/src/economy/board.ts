/**
 * The monthly Most Wanted board (§4 live ops, §13 M3): who earned the most dollars this UTC month
 * across every mode. Server-computed only: `earnings_monthly` is written by `ledgerStatements` in
 * the same batch as the ledger rows it sums (credits of EARNING_KINDS: no purchases, sinks,
 * penalties, start grants or admin adjustments), so a client can't put a number on it.
 *
 * - Accounts in the Badlands or banned are left out and don't take a rank.
 * - Ties go to whoever got there first.
 * - **Rollover.** A month is frozen once it has been over for ROLLOVER_GRACE_MS (a batch built a
 *   moment before midnight may still be committing). Freezing writes its top 10 to
 *   `most_wanted_winners` (names as they were) and grants each winner the dated frame. It runs
 *   lazily on the board and `GET /me`, and from the daily cron; it is idempotent.
 */
import type {
  MostWantedResponse,
  MostWantedRow,
} from '../../../src/experiments/out-west/contract/economy.ts'
import {
  MOST_WANTED_FRAME,
  MOST_WANTED_WINNERS,
  monthOf,
  previousMonth,
} from '../../../src/experiments/out-west/data/sinks.ts'
import type { Env } from '../env.ts'
import { FLAG_SHADOWED } from '../moderation/flags.ts'

export const ROLLOVER_GRACE_MS = 10 * 60 * 1000

/** Epoch ms of the first instant of `month` (`YYYY-MM`, UTC). */
export function monthStart(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)
}

/** Epoch ms of the first instant after `month`. */
export function monthEnd(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return Date.UTC(y ?? 1970, m ?? 1, 1)
}

const RANKED = `SELECT e.account_id, a.name, e.earned, p.level, p.prestige,
    ROW_NUMBER() OVER (ORDER BY e.earned DESC, e.updated_at ASC, e.account_id) AS rank
  FROM earnings_monthly e
  JOIN accounts a ON a.id = e.account_id
  JOIN profiles p ON p.account_id = e.account_id
  WHERE e.month = ?1 AND e.earned > 0 AND (a.flags & ${FLAG_SHADOWED}) = 0`

interface RankedRow {
  account_id: string
  name: string
  earned: number
  level: number
  prestige: number
  rank: number
}

const toRow = (r: Omit<RankedRow, 'account_id'>): MostWantedRow => ({
  rank: r.rank,
  name: r.name,
  earned: r.earned,
  level: r.level,
  prestige: r.prestige,
})

/** The live top `limit` of `month`. */
export async function liveTop(env: Env, month: string, limit: number): Promise<MostWantedRow[]> {
  const { results } = await env.DB.prepare(`${RANKED} ORDER BY rank LIMIT ?2`)
    .bind(month, limit)
    .all<RankedRow>()
  return results.map(toRow)
}

/** An account's rank and earnings in `month` (rank null if it earned nothing or is shadowed). */
export async function standingIn(
  env: Env,
  month: string,
  accountId: string,
): Promise<{ rank: number | null; earned: number }> {
  const row = await env.DB.prepare(`SELECT rank, earned FROM (${RANKED}) WHERE account_id = ?2`)
    .bind(month, accountId)
    .first<{ rank: number; earned: number }>()
  if (row) {
    return { rank: row.rank, earned: row.earned }
  }
  const own = await env.DB.prepare(
    'SELECT earned FROM earnings_monthly WHERE month = ? AND account_id = ?',
  )
    .bind(month, accountId)
    .first<{ earned: number }>()
  return { rank: null, earned: own?.earned ?? 0 }
}

/** The frozen winners of a closed month (empty if it isn't frozen yet). */
export async function frozenWinners(env: Env, month: string): Promise<MostWantedRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT w.rank, w.name, w.earned, COALESCE(p.level, 1) AS level,
       COALESCE(p.prestige, 0) AS prestige
     FROM most_wanted_winners w LEFT JOIN profiles p ON p.account_id = w.account_id
     WHERE w.month = ? ORDER BY w.rank`,
  )
    .bind(month)
    .all<Omit<RankedRow, 'account_id'>>()
  return results.map(toRow)
}

/**
 * Freezes `month` if it is over (plus the grace) and not yet frozen: its top 10 and their dated
 * frames, in one batch. Returns true if this call froze it.
 */
export async function freezeMonth(env: Env, month: string, now = Date.now()): Promise<boolean> {
  if (now < monthEnd(month) + ROLLOVER_GRACE_MS) {
    return false
  }
  const done = await env.DB.prepare('SELECT 1 AS yes FROM most_wanted_winners WHERE month = ?')
    .bind(month)
    .first<{ yes: number }>()
  if (done) {
    return false
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO most_wanted_winners (month, rank, account_id, name, earned, awarded_at)
       SELECT ?1, rank, account_id, name, earned, ?3 FROM (${RANKED}) WHERE rank <= ?2
       ON CONFLICT (month, rank) DO NOTHING`,
    ).bind(month, MOST_WANTED_WINNERS, now),
    env.DB.prepare(
      `INSERT INTO inventory (account_id, item_id, source, ref, acquired_at)
       SELECT w.account_id, ?2, 'reward', 'most-wanted:' || w.month, ?3
       FROM most_wanted_winners w JOIN profiles p ON p.account_id = w.account_id
       WHERE w.month = ?1
       ON CONFLICT (account_id, item_id) DO NOTHING`,
    ).bind(month, MOST_WANTED_FRAME, now),
  ])
  return (results[0]?.meta.changes ?? 0) > 0
}

/** Freezes last month if it is due. Cheap when it's already done. */
export async function rollover(env: Env, now = Date.now()): Promise<void> {
  await freezeMonth(env, previousMonth(monthOf(now)), now)
}

export async function mostWanted(
  env: Env,
  opts: { month: string; limit: number; accountId: string | null; now?: number },
): Promise<MostWantedResponse> {
  const now = opts.now ?? Date.now()
  await rollover(env, now)
  const current = monthOf(now)
  const prev = previousMonth(opts.month)
  const frozen = await frozenWinners(env, prev)
  const previousWinners =
    frozen.length > 0 || monthEnd(prev) > now
      ? frozen
      : await liveTop(env, prev, MOST_WANTED_WINNERS)
  return {
    month: opts.month,
    final: opts.month < current,
    closesAt: monthEnd(opts.month),
    rows: await liveTop(env, opts.month, opts.limit),
    you: opts.accountId ? await standingIn(env, opts.month, opts.accountId) : null,
    previous: { month: prev, winners: previousWinners },
  }
}
