/**
 * Recording a finished ranked run on the gauntlet leaderboard, and the account-level moderation
 * that a run's timing feeds (§8).
 */
import { ECONOMY_VERSION, scoreRun } from '../../../src/experiments/out-west/data/economy.ts'
import type { Env } from '../env.ts'
import { looksAutomated } from '../judge.ts'
import { FLAG_BADLANDS, flagStatements } from '../moderation/flags.ts'
import type { RunState } from './run-state.ts'

/** Wins a run needs before its timing can send an account to the Badlands. */
export const RANKED_FLAG_MIN_WINS = 10

/** Writes the run (if it scored) and returns its total and board rank. */
export async function recordRun(
  env: Env,
  run: RunState,
  name: { name: string; key: string },
): Promise<{ total: number; rank: number }> {
  const total = Math.max(0, Math.round(scoreRun(run.records)))
  const automated = looksAutomated(run.winReactions)
  const db = env.DB
  if (total > 0) {
    await db
      .prepare(
        `INSERT INTO runs (id, name, name_key, total, duels, wins, economy_version, client_hash,
                           created_at, flagged, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        name.name,
        name.key,
        total,
        run.records.length,
        run.winReactions.length,
        ECONOMY_VERSION,
        run.clientHash,
        Date.now(),
        automated ? 1 : 0,
        run.sessionId,
      )
      .run()
  }
  // A signed-in run whose wins are robotically steady sends the account to the Badlands.
  if (run.accountId && automated && run.winReactions.length >= RANKED_FLAG_MIN_WINS) {
    await db.batch(
      flagStatements(env, {
        accountId: run.accountId,
        bits: FLAG_BADLANDS,
        source: 'ranked',
        detail: `run ${run.sessionId}: ${run.winReactions.length} wins, σ < 12 ms`,
      }),
    )
  }
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS ahead FROM (
         SELECT name_key, MAX(total) AS best FROM runs WHERE flagged = 0 GROUP BY name_key
       ) WHERE best > ? AND name_key != ?`,
    )
    .bind(total, name.key)
    .first<{ ahead: number }>()
  return { total, rank: (row?.ahead ?? 0) + 1 }
}
