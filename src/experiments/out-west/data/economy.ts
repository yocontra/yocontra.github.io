import { assertNever } from '../contract/assertNever.ts'

/**
 * The bounty economy, shared verbatim by the game and the leaderboard server.
 *
 * Pure: no DOM, no three.js, no imports. The server imports this file by a
 * relative path and recomputes every submitted run with `scoreRun()`; it never
 * trusts the client's total. Bump ECONOMY_VERSION whenever a rule changes.
 */

export type DuelOutcome = 'win' | 'loss' | 'coward'

export interface DuelRecord {
  /** 0-based outlaw index (0..16). Underboss is 15, boss is 16. */
  level: number
  outcome: DuelOutcome
  /** ms from the call (bell) to the player's first shot; null if no shot (e.g. loss by being too slow). Negative for coward. */
  reactionMs: number | null
}

export interface RunResult {
  version: 1
  /** Every attempt in order, including losses and retries. */
  duels: DuelRecord[]
  /** Client-computed; the server recomputes with scoreRun(). */
  total: number
}

export const ECONOMY_VERSION = 1

/** The bounty on each outlaw's poster, by level. */
export const BOUNTIES: readonly number[] = [
  50, 75, 100, 150, 200, 300, 400, 500, 650, 800, 1000, 1250, 1500, 2000, 3000, 5000, 10_000,
]

/** Draw-speed bonus tiers, fastest first: a reaction under `ms` earns `pct` of the bounty. */
export const DRAW_BONUS: readonly { readonly ms: number; readonly pct: number }[] = [
  { ms: 180, pct: 0.4 },
  { ms: 220, pct: 0.25 },
  { ms: 300, pct: 0.1 },
]

/** Faster than this is anticipation, not reaction: the bounty pays, the bonus doesn't. */
export const MIN_HUMAN_MS = 100

/** A back-shot forfeits the bounty and costs this share of it (at least COWARD_FINE_MIN). */
export const COWARD_FINE = 0.1
export const COWARD_FINE_MIN = 5

export function bountyFor(level: number): number {
  if (!Number.isInteger(level)) {
    return 0
  }
  return BOUNTIES[level] ?? 0
}

/** The speed bonus alone for a win at `reactionMs` on `level`. */
export function drawBonus(level: number, reactionMs: number | null): number {
  if (reactionMs === null || !Number.isFinite(reactionMs) || reactionMs < MIN_HUMAN_MS) {
    return 0
  }
  const tier = DRAW_BONUS.find((t) => reactionMs < t.ms)
  return tier ? Math.round(bountyFor(level) * tier.pct) : 0
}

/** The fine for shooting this outlaw in the back. */
export function cowardFine(level: number): number {
  const b = bountyFor(level)
  return b > 0 ? Math.max(COWARD_FINE_MIN, Math.round(b * COWARD_FINE)) : 0
}

/** Bounty + speed bonus for a win, 0 for a loss, a negative fine for a coward. */
export function payout(record: DuelRecord): number {
  switch (record.outcome) {
    case 'win':
      return bountyFor(record.level) + drawBonus(record.level, record.reactionMs)
    case 'coward':
      return -cowardFine(record.level)
    case 'loss':
      return 0
    default:
      assertNever(record.outcome)
  }
}

/**
 * The purse for a run. Each outlaw pays once (only his first win counts), and
 * the purse never goes below zero, so fines can't push it negative.
 */
export function scoreRun(duels: readonly DuelRecord[]): number {
  const paid = new Set<number>()
  let total = 0
  for (const d of duels) {
    if (d.outcome === 'win') {
      if (paid.has(d.level)) {
        continue
      }
      paid.add(d.level)
    }
    total = Math.max(0, total + payout(d))
  }
  return total
}

export const money = (n: number): string =>
  `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`
