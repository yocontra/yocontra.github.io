import { type DuelOutcome, money } from '../data/economy.ts'
import { gradeFor } from '../data/outlaws.ts'
import { reportDuel } from '../meta/events.ts'
import { save } from '../save.ts'
import type { Verdict } from './clock.ts'
import type { NativeDirector } from './native-director.ts'
import { medalNote, trickStamp } from './native-outcome.ts'
import { practicePurse } from './purse.ts'

/** Book a resolved duel (purse, best, the report) and present its card when the beat is done. */
export function bookResult(
  d: NativeDirector,
  outcome: DuelOutcome,
  ms: number | null,
  verdict: Verdict | undefined,
): number {
  const data = d.c.save
  const before = data.run.total
  if (!(d.daily || d.remote)) {
    data.run.duels.push({
      level: d.level,
      outcome,
      reactionMs: ms === null ? null : Math.round(ms * 10) / 10,
    })
    data.run.total = verdict ? verdict.purse : practicePurse(data.run.duels)
    if (outcome === 'coward') {
      data.cowardice++
    }
    if (outcome === 'win' && ms !== null) {
      recordBest(d, ms)
    }
    save(data)
  }
  if (!d.remote) {
    reportDuel({
      level: d.level,
      legend: data.legend,
      ranked: d.ranked,
      outcome,
      reactionMs: outcome === 'coward' ? null : ms,
      // ranked medals are the server's, judged without the touch allowance
      touch: d.c.input.touch && !d.ranked,
      secondChance: d.secondChance,
      hatShot: d.hatShot,
      fakesSeen: d.fakes,
      firstTry: (data.attempts[d.level] ?? 1) <= 1,
      daily: d.daily,
    })
  }
  return before
}
export function recordBest(d: NativeDirector, ms: number): void {
  const data = d.c.save
  const best = data.best[d.level]
  if (!best || ms < best.ms) {
    data.best[d.level] = {
      ms,
      grade: gradeFor(ms, d.secondChance),
      attempts: data.attempts[d.level] ?? 1,
    }
  } else {
    best.attempts = data.attempts[d.level] ?? best.attempts
  }
}
export function showResult(
  d: NativeDirector,
  result: { outcome: DuelOutcome; ms: number | null; verdict: Verdict | undefined; before: number },
): void {
  const { outcome, ms, verdict, before } = result
  const data = d.c.save
  const hint = outcome === 'win' ? 'press to continue' : 'press to try again'
  const name = d.outlaw.name
  const cowardSub = `You drew before the bell. No bounty. (Early draws: ${data.cowardice})`
  const cards = {
    win: { title: `${name.toUpperCase()} IS DEAD`, sub: gradeFor(ms ?? 0, d.secondChance) },
    loss: {
      title: 'YOU LOSE',
      sub: d.m.loseReason === '' ? `${name} was quicker.` : d.m.loseReason,
    },
    coward: { title: 'COWARD.', sub: cowardSub },
  }
  d.c.hud.showCard({
    kind: outcome === 'loss' ? 'lose' : outcome,
    title: cards[outcome].title,
    big: outcome === 'win' && ms !== null ? `${Math.max(0, Math.round(ms))} ms` : '',
    sub: cards[outcome].sub,
    hint: d.daily ? 'press to return to the saloon' : hint,
  })
  if (outcome === 'win' && ms !== null) {
    d.c.hud.cardTimes({ you: ms, him: d.m.hisMs, note: medalNote(d, ms), himOnly: true })
    d.c.hud.cardStamp(trickStamp(d))
  } else if (outcome === 'coward') {
    const poster = d.arenas.posterImage()
    if (poster) {
      d.c.hud.cardPoster(poster)
    }
    const early = d.m.cowardEarlyMs
    d.c.hud.cardTimes({
      you: null,
      him: null,
      note:
        early === null
          ? 'You drew before the bell.'
          : `You drew ${Math.round(early)} ms before the bell.`,
    })
  }
  const delta = verdict?.payout ?? data.run.total - before
  d.c.hud.cardPayout(delta ? `${delta > 0 ? '+' : ''}${money(delta)}` : '')
  d.c.hud.setPurse(verdict?.purse ?? data.run.total, true)
}
