/**
 * Medals, challenges and the solo cosmetics on the account (the meta-game stream). Everything here
 * is booked from evidence the server judged itself: a ranked win's reaction and wait stats (the
 * credit job), a recorded win for a claimed hat shot, a daily win on the board.
 *
 * Idempotency: each medal tier pays under `medal:<account>:<outlaw>:<tier>` and each challenge
 * under `challenge:<account>:<id>`, forever. A retried credit job, two runs at once, or a replayed
 * claim can never pay twice; the `outlaw_marks` upsert only ever raises a mark.
 */
import {
  CHALLENGE_PAY,
  CHALLENGES,
  type Challenge,
  CLAIM_PAY,
  CLAIM_WINDOW_MS,
  challengeFor,
  earnedRewards,
  emptyMark,
  isClaim,
  medalPay,
  meets,
  OUTLAW_COUNT,
  type OutlawMark,
  type TierRank,
  tierFor,
  tierName,
} from '../../../src/experiments/out-west/data/medals.ts'
import type { Env } from '../env.ts'
import { ledgerStatements } from './ledger.ts'

/** What a server-judged ranked win shows (the hat shot is never server evidence). */
export interface SoloEvidence {
  reactionMs: number | null
  /** Played by touch (see `medalMs`). Absent on jobs queued before it existed. */
  touch?: boolean
  fakesSeen: number
  firstTry: boolean
  clean: boolean
}

interface MarkRow {
  outlaw: number
  tier: number
  best_ms: number | null
  challenge: number
  last_run: string | null
  last_win_at: number | null
}

/** The account's marks, one per outlaw (empty where none). */
export async function marksOf(env: Env, accountId: string): Promise<OutlawMark[]> {
  const { results } = await env.DB.prepare(
    'SELECT outlaw, tier, best_ms, challenge, last_run, last_win_at FROM outlaw_marks WHERE account_id = ?',
  )
    .bind(accountId)
    .all<MarkRow>()
  const marks = Array.from({ length: OUTLAW_COUNT }, emptyMark)
  for (const r of results) {
    if (r.outlaw >= 0 && r.outlaw < OUTLAW_COUNT) {
      marks[r.outlaw] = {
        tier: Math.min(3, Math.max(0, r.tier)) as TierRank,
        bestMs: r.best_ms,
        challenge: r.challenge === 1,
      }
    }
  }
  return marks
}

/** Days this account won the Daily Outlaw. */
export async function dailyWinsOf(env: Env, accountId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT day) AS n FROM daily_runs
     WHERE account_id = ? AND outcome = 'win' AND flagged = 0`,
  )
    .bind(accountId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const UPSERT_MARK = `INSERT INTO outlaw_marks
  (account_id, outlaw, tier, best_ms, challenge, last_run, last_win_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
ON CONFLICT (account_id, outlaw) DO UPDATE SET
  tier = MAX(tier, excluded.tier),
  best_ms = CASE WHEN excluded.best_ms IS NULL THEN best_ms
                 WHEN best_ms IS NULL THEN excluded.best_ms
                 ELSE MIN(best_ms, excluded.best_ms) END,
  challenge = MAX(challenge, excluded.challenge),
  last_run = COALESCE(excluded.last_run, last_run),
  last_win_at = COALESCE(excluded.last_win_at, last_win_at),
  updated_at = excluded.updated_at`

/** Grants every solo reward item the marks (and daily wins) now earn. Idempotent. */
function rewardStatements(
  env: Env,
  accountId: string,
  marks: readonly OutlawMark[],
  dailyWins: number,
): D1PreparedStatement[] {
  const now = Date.now()
  return earnedRewards({ marks, dailyWins, legendBest: 0 }).map((item) =>
    env.DB.prepare(
      `INSERT INTO inventory (account_id, item_id, source, acquired_at)
       SELECT ?1, ?2, 'reward', ?3 WHERE EXISTS (SELECT 1 FROM profiles WHERE account_id = ?1)
       ON CONFLICT (account_id, item_id) DO NOTHING`,
    ).bind(accountId, item, now),
  )
}

function challengeEntry(accountId: string, c: Challenge, runId: string) {
  const pay = isClaim(c) ? CLAIM_PAY : CHALLENGE_PAY
  return {
    key: `challenge:${accountId}:${c.id}`,
    entry: {
      accountId,
      kind: 'challenge' as const,
      amount: pay.cash,
      xp: pay.xp,
      ref: `${c.id}:${runId}`,
    },
  }
}

/**
 * The statements for a paid ranked win of outlaw `level` (0..16) on run `runId`: any new medal
 * tiers, a server-judged challenge, the mark (with the run, for a later hat-shot claim) and any
 * solo reward items this completes. Put them in the credit job's batch.
 */
export async function medalStatements(
  env: Env,
  win: { accountId: string; level: number; runId: string; ev: SoloEvidence },
): Promise<D1PreparedStatement[]> {
  const { accountId, level, runId, ev } = win
  if (!Number.isInteger(level) || level < 0 || level >= OUTLAW_COUNT || accountId === '') {
    return []
  }
  const marks = await marksOf(env, accountId)
  const cur = marks[level] ?? emptyMark()
  const tier = tierFor(level, ev.reactionMs, ev.touch === true)
  const c = challengeFor(level)
  const met = c !== undefined && !isClaim(c) && meets(c, { ...ev, hatShot: false })
  const statements: D1PreparedStatement[] = []
  for (let r = cur.tier + 1; r <= tier; r++) {
    const rank = r as TierRank
    const pay = medalPay((r - 1) as TierRank, rank)
    statements.push(
      ...ledgerStatements(env, `medal:${accountId}:${level}:${r}`, [
        {
          accountId,
          kind: 'medal',
          amount: pay.cash,
          xp: pay.xp,
          ref: `${level}:${tierName(rank)}:${runId}`,
        },
      ]),
    )
  }
  if (met && c && !cur.challenge) {
    const { key, entry } = challengeEntry(accountId, c, runId)
    statements.push(...ledgerStatements(env, key, [entry]))
  }
  const now = Date.now()
  const counted = tier > 0 && ev.reactionMs !== null ? Math.round(ev.reactionMs) : null
  statements.push(
    env.DB.prepare(UPSERT_MARK).bind(
      accountId,
      level,
      tier,
      counted !== null && counted > 0 ? counted : null,
      met ? 1 : 0,
      runId,
      now,
    ),
  )
  const after = marks.slice()
  after[level] = {
    tier: Math.max(cur.tier, tier) as TierRank,
    bestMs: cur.bestMs,
    challenge: cur.challenge || met,
  }
  statements.push(...rewardStatements(env, accountId, after, await dailyWinsOf(env, accountId)))
  return statements
}

export type ClaimRefusal = 'unknown' | 'not_claim' | 'no_win' | 'done'

/**
 * A claimed (hat-shot) challenge: XP only, and only against a ranked win of that outlaw that the
 * server recorded on `runId` within CLAIM_WINDOW_MS. The aim itself can't be verified: that is the
 * honest limit, bounded to three challenges × 50 XP per account, once.
 */
export async function claimStatements(
  env: Env,
  claim: { accountId: string; challengeId: string; runId: string; now?: number },
): Promise<{ statements: D1PreparedStatement[]; xp: number; granted: string[] } | ClaimRefusal> {
  const { accountId, challengeId, runId, now = Date.now() } = claim
  const c = CHALLENGES.find((x) => x.id === challengeId)
  if (!c) {
    return 'unknown'
  }
  if (!isClaim(c)) {
    return 'not_claim'
  }
  const row = await env.DB.prepare(
    'SELECT challenge, last_run, last_win_at FROM outlaw_marks WHERE account_id = ? AND outlaw = ?',
  )
    .bind(accountId, c.level)
    .first<{ challenge: number; last_run: string | null; last_win_at: number | null }>()
  if (row?.challenge === 1) {
    return 'done'
  }
  if (
    !row ||
    typeof runId !== 'string' ||
    runId === '' ||
    row.last_run !== runId ||
    row.last_win_at === null ||
    now - row.last_win_at > CLAIM_WINDOW_MS ||
    row.last_win_at > now + 60_000
  ) {
    return 'no_win'
  }
  const marks = await marksOf(env, accountId)
  const before = earnedRewards({ marks, dailyWins: 0, legendBest: 0 })
  const after = marks.slice()
  const m = after[c.level] ?? emptyMark()
  after[c.level] = { ...m, challenge: true }
  const dailyWins = await dailyWinsOf(env, accountId)
  const granted = earnedRewards({ marks: after, dailyWins, legendBest: 0 }).filter(
    (i) => !before.includes(i),
  )
  const { key, entry } = challengeEntry(accountId, c, runId)
  return {
    statements: [
      ...ledgerStatements(env, key, [entry]),
      env.DB.prepare(
        'UPDATE outlaw_marks SET challenge = 1, updated_at = ?3 WHERE account_id = ?1 AND outlaw = ?2',
      ).bind(accountId, c.level, now),
      ...rewardStatements(env, accountId, after, dailyWins),
    ],
    xp: entry.xp,
    granted,
  }
}

/** The daily wins reward check, after a daily win commits (the Black Bandana at seven days). */
export async function dailyRewardStatements(
  env: Env,
  accountId: string,
): Promise<D1PreparedStatement[]> {
  return rewardStatements(
    env,
    accountId,
    await marksOf(env, accountId),
    await dailyWinsOf(env, accountId),
  )
}
