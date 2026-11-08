import { type DuelRecord, payout } from '../data/economy.ts'

export const PRACTICE_FINE_CAP = 0.1

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
