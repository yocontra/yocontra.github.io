import { bountyFor, type DuelOutcome, type DuelRecord, money, payout } from '../data/economy.ts'
import { save as persist } from '../save.ts'
import type { DuelState } from './state.ts'

/** The server's numbers for a ranked duel (it owns the purse). */
export interface Paid {
  payout: number
  purse: number
}

/** A practice back-shot never costs more than this share of the purse. */
export const PRACTICE_FINE_CAP = 0.1

/**
 * The practice purse: `scoreRun` (each outlaw pays once, never below zero), but a coward's fine is
 * capped at 10% of the purse at the time, so a double tap on the boss can't take $1,000 off a
 * practice run. Ranked purses are the server's `scoreRun`, uncapped.
 */
export function practicePurse(duels: readonly DuelRecord[]): number {
  const paid = new Set<number>()
  let total = 0
  for (const d of duels) {
    if (d.outcome === 'win') {
      if (paid.has(d.level)) {
        continue
      }
      paid.add(d.level)
    }
    let delta = payout(d)
    if (d.outcome === 'coward') {
      delta = -Math.min(-delta, Math.round(total * PRACTICE_FINE_CAP))
    }
    total = Math.max(0, total + delta)
  }
  return total
}

/**
 * Log a duel in the run. Practice scores it locally; ranked takes the
 * server's payout and purse as given. Returns the change in the purse.
 */
export function book(
  s: DuelState,
  rec: { outcome: DuelOutcome; reactionMs: number | null },
  paid: Paid | null,
): number {
  const run = s.c.save.run
  const before = run.total
  run.duels.push({
    level: s.level,
    outcome: rec.outcome,
    reactionMs: rec.reactionMs === null ? null : Math.round(rec.reactionMs * 10) / 10,
  })
  run.total = paid ? paid.purse : practicePurse(run.duels)
  persist(s.c.save)
  return paid ? paid.payout : run.total - before
}

/** Tick the purse to its new total, with a little cash-register jingle on a gain. */
export function showPurse(s: DuelState, delta: number): void {
  const c = s.c
  c.hud.setPurse(c.save.run.total, true)
  if (delta > 0) {
    c.audio.play('coin', { gain: 0.8 })
    c.audio.play('coin', { gain: 0.6, rate: 1.26, when: c.audio.now + 0.09 })
    c.audio.play('coin', { gain: 0.5, rate: 1.5, when: c.audio.now + 0.19 })
  }
}

/** "+$150 · speed bonus +$37" (the card already shows the time). */
export function payLine(s: DuelState): string {
  const paid = s.winDelta
  if (paid <= 0) {
    return 'No bounty for this one.'
  }
  const bounty = Math.min(paid, bountyFor(s.level))
  const bonus = paid - bounty
  const base = `+${money(bounty)}`
  return bonus > 0 ? `${base} · speed bonus +${money(bonus)}` : base
}
