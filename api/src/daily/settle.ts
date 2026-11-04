/**
 * Settling one Daily Outlaw attempt (meta-game stream): the attempt's row, the once-a-day payout
 * through the ledger, the Black Bandana check, and the board place. Called by the DailySession
 * with the server's own verdict; kept apart from the Durable Object so it is unit-tested.
 */
import { DAILY_PAY } from '../../../src/experiments/out-west/data/daily.ts'
import { ledgerStatements } from '../economy/ledger.ts'
import { dailyRewardStatements } from '../economy/medals.ts'
import type { Env } from '../env.ts'
import { dailyRank } from './board.ts'

export interface DailyAttempt {
  id: string
  day: string
  accountId: string | null
  outcome: 'win' | 'loss' | 'coward'
  reactionMs: number | null
}

export interface DailySettled {
  /** Dollars and XP paid by this attempt (0 when already paid today, a loss, or a guest). */
  cash: number
  xp: number
  /** Board place after it (signed-in wins only). */
  rank: number | null
}

export const dailyKey = (accountId: string, day: string): string => `daily:${accountId}:${day}`

export async function settleDaily(env: Env, a: DailyAttempt): Promise<DailySettled> {
  const win = a.outcome === 'win'
  const ms = win && a.reactionMs !== null ? Math.max(1, Math.round(a.reactionMs)) : null
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE daily_runs SET outcome = ?2, reaction_ms = ?3, settled_at = ?4
       WHERE id = ?1 AND outcome IS NULL`,
    ).bind(a.id, a.outcome, ms, Date.now()),
  ]
  const account = a.accountId
  let paid = false
  if (account && win) {
    const before = await env.DB.prepare('SELECT 1 AS yes FROM ledger WHERE idem_key = ?')
      .bind(`${dailyKey(account, a.day)}#0`)
      .first<{ yes: number }>()
    paid = !before
    statements.push(
      ...ledgerStatements(env, dailyKey(account, a.day), [
        {
          accountId: account,
          kind: 'daily_outlaw',
          amount: DAILY_PAY.cash,
          xp: DAILY_PAY.xp,
          ref: a.day,
        },
      ]),
    )
  }
  await env.DB.batch(statements)
  if (!(account && win)) {
    return { cash: 0, xp: 0, rank: null }
  }
  // the Black Bandana counts days with a win, the one just written included
  const rewards = await dailyRewardStatements(env, account)
  if (rewards.length > 0) {
    await env.DB.batch(rewards)
  }
  return {
    cash: paid ? DAILY_PAY.cash : 0,
    xp: paid ? DAILY_PAY.xp : 0,
    rank: await dailyRank(env, a.day, account),
  }
}
