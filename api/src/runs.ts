/**
 * Server-side run validation. The client's total is never trusted: the run log is checked for
 * plausibility and re-scored with the same economy module the game uses.
 */
import {
  type DuelRecord,
  ECONOMY_VERSION,
  type RunResult,
  scoreRun,
} from '../../src/experiments/out-west/data/economy.ts'

export const LAST_LEVEL = 16
/** Faster than this is not a human reacting to a bell. */
export const MIN_REACTION_MS = 100
export const MAX_DUELS = 400

export interface ScoredRun {
  duels: DuelRecord[]
  total: number
  wins: number
}

export type RunCheck = { ok: true; run: ScoredRun } | { ok: false; error: string }

const OUTCOMES = new Set(['win', 'loss', 'coward'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDuel(value: unknown): DuelRecord | null {
  if (!isRecord(value)) {
    return null
  }
  const { level, outcome, reactionMs } = value
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > LAST_LEVEL) {
    return null
  }
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    return null
  }
  if (reactionMs !== null && (typeof reactionMs !== 'number' || !Number.isFinite(reactionMs))) {
    return null
  }
  if (typeof reactionMs === 'number' && Math.abs(reactionMs) > 120_000) {
    return null
  }
  return { level, outcome: outcome as DuelRecord['outcome'], reactionMs }
}

export function validateRun(raw: unknown): RunCheck {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Missing run.' }
  }
  const run = raw as Partial<RunResult>
  if (run.version !== ECONOMY_VERSION) {
    return { ok: false, error: 'Unsupported game version.' }
  }
  if (!Array.isArray(run.duels) || run.duels.length === 0) {
    return { ok: false, error: 'Run has no duels.' }
  }
  if (run.duels.length > MAX_DUELS) {
    return { ok: false, error: 'Run is too long.' }
  }

  const duels: DuelRecord[] = []
  for (const value of run.duels) {
    const duel = parseDuel(value)
    if (!duel) {
      return { ok: false, error: 'Malformed duel record.' }
    }
    duels.push(duel)
  }

  // Progression: you face outlaws in order and only advance by winning.
  // A run may start part-way through the gauntlet (a resumed save), but never skip ahead.
  let expected = duels[0]?.level ?? 0
  let wins = 0
  for (const duel of duels) {
    if (duel.level !== expected) {
      return { ok: false, error: 'Duels are out of order.' }
    }
    if (duel.outcome === 'win') {
      if (duel.reactionMs === null || duel.reactionMs < MIN_REACTION_MS) {
        return { ok: false, error: 'Implausible reaction time.' }
      }
      wins++
      // After the boss, `expected` is 17, so any further duel is rejected as out of order.
      expected++
    } else if (duel.outcome === 'coward' && duel.reactionMs !== null && duel.reactionMs >= 0) {
      return { ok: false, error: 'Inconsistent duel record.' }
    }
  }

  const total = Math.max(0, Math.round(scoreRun(duels)))
  return { ok: true, run: { duels, total, wins } }
}
