import type { DuelOutcome } from '../data/economy.ts'
import { reportDuel } from '../meta/events.ts'
import type { Director } from './director.ts'

/**
 * One decided single-player attempt, to the meta-game: a win (for the boss, only the phase-two
 * kill), a loss or a coward. Never for Bounty Hunt (the server-driven duel installs `hooks`).
 */
export function report(d: Director, outcome: DuelOutcome, reactionMs: number | null): void {
  if (d.hooks) {
    return
  }
  reportDuel({
    level: d.level,
    legend: d.c.save.legend,
    ranked: d.ranked,
    outcome,
    reactionMs,
    // ranked medals are the server's, judged without the allowance; the device's marks match
    touch: d.c.input.touch && !d.ranked,
    secondChance: d.secondChance,
    hatShot: d.hatShot,
    fakesSeen: d.fakesSeen,
    firstTry: (d.c.save.attempts[d.level] ?? 1) <= 1,
    daily: d.daily,
  })
}
