/**
 * The duel's report to the meta-game: one call per decided single-player attempt (medals,
 * challenges, the guest purse, achievements and the Daily Outlaw all listen here). The duel calls
 * `reportDuel`; nothing in here knows about the duel, so either side can change freely.
 *
 * Call sites (duel-core): `duel/outcome.ts` `win()` (for the boss, only the phase-two kill),
 * `duel/defeat.ts` on a loss or a coward. Never called for Bounty Hunt.
 */

import type { DuelOutcome } from '../data/economy.ts'

export type DuelReportOutcome = DuelOutcome

export interface DuelReport {
  /** Outlaw index into OUTLAWS (0-based). For a daily duel, the outlaw it borrowed. */
  level: number
  /** A Legend run (faster draws): medals and challenges don't count. */
  legend: boolean
  /** A server-judged ranked run (the account side is booked by the server, not from here). */
  ranked: boolean
  outcome: DuelReportOutcome
  /** Your first shot after the call, ms. Null when you never drew (or drew early). */
  reactionMs: number | null
  /** The shot was a tap (medals take the touch allowance off the reaction). */
  touch: boolean
  /** You won on a second chance (he missed). */
  secondChance: boolean
  /** Your shot took his hat (pointer aim). */
  hatShot: boolean
  /** Fake-outs that fired during this attempt's wait. */
  fakesSeen: number
  /** No earlier attempt on this outlaw in this run. */
  firstTry: boolean
  /** The Daily Outlaw duel. */
  daily: boolean
}

type Listener = (r: DuelReport) => void

const listeners = new Set<Listener>()

/** Listen for decided attempts. Returns the unsubscribe. */
export function onDuelReport(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Called by the duel once per decided attempt. Listener errors never reach the duel. */
export function reportDuel(r: DuelReport): void {
  for (const fn of listeners) {
    try {
      fn(r)
    } catch (err) {
      console.error('duel report listener failed', err)
    }
  }
}

/**
 * A page the meta-game shows between duels: the Perdition Gazette before the next outlaw's poster,
 * or the boss epilogue and credits before the end ledger. The duel awaits it with input held, then
 * carries on. Null when there is nothing to show (or no handler is set).
 */
export type Interlude = { kind: 'next'; level: number } | { kind: 'end'; legend: boolean }

let interludeFn: ((i: Interlude) => Promise<void> | null) | null = null

/** The meta-game's single interlude handler (the Gazette). */
export function setInterlude(fn: ((i: Interlude) => Promise<void> | null) | null): void {
  interludeFn = fn
}

/**
 * Called by the duel at `nextLevel()` (kind 'next', the outlaw about to be faced) and at `toEnd()`
 * before the ledger (kind 'end'). Await the promise if one comes back; never throws or rejects.
 */
export function interlude(i: Interlude): Promise<void> | null {
  try {
    const p = interludeFn?.(i) ?? null
    return p ? p.catch(() => undefined) : null
  } catch {
    return null
  }
}
