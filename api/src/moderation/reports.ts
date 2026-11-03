/**
 * Player reports and blocks (§11.4 "Report and Block on every poster", §12.1 `POST /reports`,
 * `POST /blocks`).
 *
 * Reports: one per reporter, target and UTC day. Only licensed reporters who aren't flagged
 * themselves count, and each counts once per 30 days however often they report:
 * - REPORTED_AT (3) different reporters (any reason) set the `reported` bit;
 * - BADLANDS_REPORTS_AT (5) different reporters of `cheating` send the account to the Badlands.
 */
import type { ReportReason } from '../../../src/experiments/out-west/contract/social.ts'
import { LICENCE_MASK } from '../../../src/experiments/out-west/data/licence.ts'
import {
  BADLANDS_REPORTS_AT,
  MAX_BLOCKS,
  REPORT_WINDOW_MS,
  REPORTED_AT,
} from '../../../src/experiments/out-west/data/sinks.ts'
import type { Env } from '../env.ts'
import { FLAG_BADLANDS, FLAG_REPORTED, FLAG_SHADOWED, flagStatements } from './flags.ts'

/** Reports that count: licensed, unflagged reporters, within the window, one per reporter. */
const COUNTING = `SELECT COUNT(DISTINCT r.reporter_id) AS n FROM reports r
  JOIN accounts a ON a.id = r.reporter_id
  JOIN profiles p ON p.account_id = r.reporter_id
  WHERE r.target_id = ?1 AND r.created_at > ?2 AND (a.flags & ${FLAG_SHADOWED}) = 0
    AND (p.gauntlet_clears & ${LICENCE_MASK}) = ${LICENCE_MASK}`

export interface ReportOutcome {
  /** False when today's report from this reporter already existed (accepted, ignored). */
  recorded: boolean
  flagsSet: number
}

export async function fileReport(
  env: Env,
  opts: {
    reporterId: string
    targetId: string
    reason: ReportReason
    context: string | null
    now?: number
  },
): Promise<ReportOutcome> {
  const now = opts.now ?? Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const inserted = await env.DB.prepare(
    `INSERT INTO reports (reporter_id, target_id, reason, context, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (reporter_id, target_id, day) DO NOTHING`,
  )
    .bind(opts.reporterId, opts.targetId, opts.reason, opts.context, day, now)
    .run()
  if (inserted.meta.changes === 0) {
    return { recorded: false, flagsSet: 0 }
  }
  const since = now - REPORT_WINDOW_MS
  const [all, cheating] = await env.DB.batch([
    env.DB.prepare(COUNTING).bind(opts.targetId, since),
    env.DB.prepare(`${COUNTING} AND r.reason = 'cheating'`).bind(opts.targetId, since),
  ])
  const count = (r: D1Result | undefined): number =>
    (r?.results as { n: number }[] | undefined)?.[0]?.n ?? 0
  let bits = 0
  if (count(all) >= REPORTED_AT) {
    bits |= FLAG_REPORTED
  }
  if (count(cheating) >= BADLANDS_REPORTS_AT) {
    bits |= FLAG_BADLANDS
  }
  if (bits !== 0) {
    await env.DB.batch(
      flagStatements(env, {
        accountId: opts.targetId,
        bits,
        source: 'reports',
        detail: `${count(all)} reporters, ${count(cheating)} for cheating`,
        now,
      }),
    )
  }
  return { recorded: true, flagsSet: bits }
}

/** Names this account blocks, newest first. */
export async function blockedNames(env: Env, accountId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.name FROM blocks b JOIN accounts a ON a.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY b.created_at DESC, a.name`,
  )
    .bind(accountId)
    .all<{ name: string }>()
  return results.map((r) => r.name)
}

/** Blocks `targetId`. False when the block list is full. Blocking twice is a no-op. */
export async function block(
  env: Env,
  opts: { blockerId: string; targetId: string; now?: number },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO blocks (blocker_id, blocked_id, created_at)
     SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM blocks WHERE blocker_id = ?1) < ?4
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
  )
    .bind(opts.blockerId, opts.targetId, opts.now ?? Date.now(), MAX_BLOCKS)
    .run()
  if (result.meta.changes > 0) {
    return true
  }
  const existing = await env.DB.prepare(
    'SELECT 1 AS yes FROM blocks WHERE blocker_id = ? AND blocked_id = ?',
  )
    .bind(opts.blockerId, opts.targetId)
    .first<{ yes: number }>()
  return existing !== null
}

export async function unblock(env: Env, blockerId: string, targetId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .bind(blockerId, targetId)
    .run()
}

/** True when either account blocks the other. */
export async function eitherBlocks(env: Env, a: string, b: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS yes FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2)
       OR (blocker_id = ?2 AND blocked_id = ?1) LIMIT 1`,
  )
    .bind(a, b)
    .first<{ yes: number }>()
  return row !== null
}
