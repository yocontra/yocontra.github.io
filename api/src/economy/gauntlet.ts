/**
 * Gauntlet grants for signed-in ranked runs (M0). Owned by stream C; called by stream B's ranked
 * DuelSession on every judged win of a signed-in player.
 */
import { BOUNTIES } from '../../../src/experiments/out-west/data/economy.ts'
import {
  GAUNTLET_REPEAT_XP,
  GAUNTLET_REPEAT_XP_PER_DAY,
  gauntletFirstClearCash,
  gauntletFirstClearXp,
} from '../../../src/experiments/out-west/data/progression.ts'
import type { Env } from '../env.ts'
import { ledgerStatements } from './ledger.ts'

/** All 17 outlaws cleared. */
export const FULL_CLEAR_MASK = (1 << BOUNTIES.length) - 1

const dayStart = (now: number): number => now - (now % 86_400_000)

/**
 * The account grant for beating outlaw `level` (0..16) on ranked run `runId`.
 * - **First clear** (per account, ever): 40 + 15·level XP and 10% of the poster in dollars,
 *   idempotency key `gauntlet:first:<accountId>:<level>`. Sets the bit in `gauntlet_clears`, and the
 *   17th bit grants Hardin's Pair.
 * - **Repeat win:** 10 XP, at most 200 XP per UTC day, key `gauntlet:repeat:<runId>:<level>`.
 * Returns [] when there's no profile, the level is out of range, the daily cap is reached, or this
 * run already first-cleared this level (so a retried write is a no-op, not a repeat-XP grant).
 * Callers put the statements in their own batch.
 */
export async function gauntletClearStatements(
  env: Env,
  accountId: string,
  level: number,
  runId: string,
): Promise<D1PreparedStatement[]> {
  if (!Number.isInteger(level) || level < 0 || level >= BOUNTIES.length) {
    return []
  }
  const now = Date.now()
  const firstRef = `first:${runId}:${level}`
  const row = await env.DB.prepare(
    `SELECT p.gauntlet_clears AS clears,
       (SELECT COALESCE(SUM(l.xp), 0) FROM ledger l
         WHERE l.account_id = p.account_id AND l.kind = 'gauntlet_clear'
           AND l.ref LIKE 'repeat:%' AND l.created_at >= ?2) AS repeat_xp,
       EXISTS (SELECT 1 FROM ledger l
         WHERE l.account_id = p.account_id AND l.kind = 'gauntlet_clear' AND l.ref = ?3) AS first_here
     FROM profiles p WHERE p.account_id = ?1`,
  )
    .bind(accountId, dayStart(now), firstRef)
    .first<{ clears: number; repeat_xp: number; first_here: number }>()
  if (!row) {
    return []
  }
  if (row.first_here) {
    // A retry of this very win (its first write committed but the caller never heard): already paid.
    return []
  }
  const bit = 1 << level
  if ((row.clears & bit) === 0) {
    return [
      ...ledgerStatements(env, `gauntlet:first:${accountId}:${level}`, [
        {
          accountId,
          kind: 'gauntlet_clear',
          amount: gauntletFirstClearCash(level),
          xp: gauntletFirstClearXp(level),
          ref: firstRef,
        },
      ]),
      env.DB.prepare(
        'UPDATE profiles SET gauntlet_clears = gauntlet_clears | ?2 WHERE account_id = ?1',
      ).bind(accountId, bit),
      env.DB.prepare(
        `INSERT INTO inventory (account_id, item_id, source, acquired_at)
         SELECT account_id, 'gun.hardins-pair', 'reward', ?2 FROM profiles
          WHERE account_id = ?1 AND gauntlet_clears = ?3
         ON CONFLICT (account_id, item_id) DO NOTHING`,
      ).bind(accountId, now, FULL_CLEAR_MASK),
    ]
  }
  if (row.repeat_xp + GAUNTLET_REPEAT_XP > GAUNTLET_REPEAT_XP_PER_DAY) {
    return []
  }
  return ledgerStatements(env, `gauntlet:repeat:${runId}:${level}`, [
    {
      accountId,
      kind: 'gauntlet_clear',
      amount: 0,
      xp: GAUNTLET_REPEAT_XP,
      ref: `repeat:${runId}:${level}`,
    },
  ])
}
