/**
 * A ranked run's server-owned progress, persisted in the DuelSession's storage so it survives a
 * dropped socket and a restart of the object (resume, `contract/ranked.ts`). Pure: no Workers APIs.
 */
import type { RankedResumed } from '../../../src/experiments/out-west/contract/ranked.ts'
import { RANKED_RESUME_WINDOW_MS } from '../../../src/experiments/out-west/contract/ranked.ts'
import { type DuelRecord, scoreRun } from '../../../src/experiments/out-west/data/economy.ts'

export type Phase = 1 | 2

export interface RunState {
  sessionId: string
  clientHash: string
  accountId: string | null
  accountName: string | null
  /** The outlaw to face next (0-based). */
  level: number
  phase: Phase
  /** Every outlaw beaten. */
  complete: boolean
  /** `finish` answered (or the run expired): no more duels, no resume. */
  finished: boolean
  /** Decided duels (the boss's first phase isn't one). */
  records: DuelRecord[]
  /** Judged reactions of the won duels, for the bot heuristic. */
  winReactions: number[]
  /** Drew early at least once this run (the Midnight frame needs a clean run). */
  coward: boolean
  /** The lowest duel number allowed next. Duel numbers only go up, so a voided one is never reused. */
  nextDuel: number
  /** The duel started but not yet decided (voided if the socket drops or the object restarts). */
  inProgress: number | null
  /** When the socket dropped (null while connected). */
  droppedAt: number | null
  /** Last time this state was written. Stands in for `droppedAt` after a restart. */
  savedAt: number
}

export function newRun(opts: {
  sessionId: string
  clientHash: string
  accountId: string | null
  accountName: string | null
  now: number
}): RunState {
  return {
    ...opts,
    level: 0,
    phase: 1,
    complete: false,
    finished: false,
    records: [],
    winReactions: [],
    coward: false,
    nextDuel: 0,
    inProgress: null,
    droppedAt: null,
    savedAt: opts.now,
  }
}

export type ResumeVerdict = 'ok' | 'finished' | 'expired'

/**
 * May a socket resume `run` at `now`? `connected` says whether a socket is live right now (a second
 * tab taking over is fine). After a restart nothing is connected and `droppedAt` may be null (the
 * socket died with the object): the last save stands in for the drop.
 */
export function resumeVerdict(run: RunState, now: number, connected: boolean): ResumeVerdict {
  if (run.finished) {
    return 'finished'
  }
  if (connected) {
    return 'ok'
  }
  const since = run.droppedAt ?? run.savedAt
  return now - since > RANKED_RESUME_WINDOW_MS ? 'expired' : 'ok'
}

export function resumedInfo(run: RunState, voided: number | null): RankedResumed {
  return {
    level: run.level,
    phase: run.phase,
    purse: scoreRun(run.records),
    nextDuel: run.nextDuel,
    voided,
    complete: run.complete,
    duels: run.records.length,
  }
}

export const RUN_KEY = 'run'
