/**
 * The Daily Outlaw's board (meta-game stream): each signed-in gunslinger's best winning draw of the
 * UTC day, fastest first. Badlands and banned accounts, and flagged attempts, are left out.
 */
import type {
  DailyBoardResponse,
  DailyBoardRow,
} from '../../../src/experiments/out-west/contract/meta.ts'
import { DAILY_BOARD_SIZE } from '../../../src/experiments/out-west/data/daily.ts'
import type { Env } from '../env.ts'
import { FLAG_SHADOWED } from '../moderation/flags.ts'

const BEST = `SELECT d.account_id AS account_id, a.name AS name, MIN(d.reaction_ms) AS ms,
    MIN(d.settled_at) AS at
  FROM daily_runs d JOIN accounts a ON a.id = d.account_id
  WHERE d.day = ?1 AND d.outcome = 'win' AND d.flagged = 0 AND d.reaction_ms IS NOT NULL
    AND (a.flags & ${FLAG_SHADOWED}) = 0
  GROUP BY d.account_id`

/** `account`'s place on `day`'s board (1 = fastest), or null when not on it. */
export async function dailyRank(env: Env, day: string, account: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `WITH best AS (${BEST})
     SELECT (SELECT COUNT(*) FROM best b WHERE b.ms < me.ms) + 1 AS rank
     FROM best me WHERE me.account_id = ?2`,
  )
    .bind(day, account)
    .first<{ rank: number }>()
  return row?.rank ?? null
}

export async function dailyBoard(
  env: Env,
  day: string,
  account: string | null,
): Promise<DailyBoardResponse> {
  const { results } = await env.DB.prepare(`${BEST} ORDER BY ms ASC, at ASC LIMIT ?2`)
    .bind(day, DAILY_BOARD_SIZE)
    .all<{ account_id: string; name: string; ms: number }>()
  const rows: DailyBoardRow[] = []
  let rank = 0
  let prev = -1
  for (const [i, r] of results.entries()) {
    // equal times share a place
    rank = r.ms === prev ? rank : i + 1
    prev = r.ms
    rows.push({ rank, name: r.name, ms: r.ms })
  }
  let you: DailyBoardResponse['you'] = null
  if (account) {
    const mine = await env.DB.prepare(
      `SELECT MIN(reaction_ms) AS ms FROM daily_runs
       WHERE day = ? AND account_id = ? AND outcome = 'win' AND flagged = 0`,
    )
      .bind(day, account)
      .first<{ ms: number | null }>()
    const r = mine?.ms ? await dailyRank(env, day, account) : null
    you = mine?.ms && r ? { rank: r, ms: mine.ms } : null
  }
  return { day, rows, you }
}
