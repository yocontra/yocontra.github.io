import type { Verdict } from './clock.ts'
import { coward, cowardFined, shotDown } from './defeat.ts'
import type { Director } from './director.ts'
import { killRifleman, win } from './outcome.ts'
import { book } from './purse.ts'

const LIVE = new Set(['wait', 'bossClock', 'call'])

/**
 * Ranked: the server's verdict is the authority. Play the kill cam, the death
 * or the back-shot to match, and take its payout and purse as given.
 */
export function onVerdict(d: Director, v: Verdict): void {
  const paid = { payout: v.payout, purse: v.purse }
  if (v.duel !== d.duelId) {
    // a duel we already finished on screen (a stall): just book it
    book(d, { outcome: v.outcome, reactionMs: v.reactionMs }, paid)
    d.c.hud.setPurse(v.purse, true)
    return
  }
  switch (v.outcome) {
    case 'coward':
      if (d.phase !== 'coward') {
        coward(d, d.phase === 'call' ? 'Too quick to be a reaction. That was a guess.' : '')
      }
      cowardFined(d, paid)
      break
    case 'loss':
      if (LIVE.has(d.phase)) {
        // the rifleman fires first; if you'd already dropped him, it was Curly
        const who = d.underboss && v.targetsHit === 0 ? 1 : 0
        if (d.underboss && v.targetsHit > 0) {
          killRifleman(d)
        }
        shotDown(d, who, paid)
      } else {
        book(d, { outcome: 'loss', reactionMs: v.reactionMs }, paid)
        d.c.hud.setPurse(v.purse, true)
      }
      break
    default:
      if (d.phase !== 'call') {
        book(d, { outcome: 'win', reactionMs: v.reactionMs }, paid)
        return
      }
      killRifleman(d)
      d.enemyAlive = false
      d.lastReaction = v.reactionMs ?? d.lastReaction
      win(d, v.reactionMs ?? 0, paid)
      break
  }
}

/** The ranked connection is gone: carry on in practice from here. */
export function onDropped(d: Director, reason: string): void {
  if (!d.ranked) {
    return
  }
  d.setPractice(`[${reason} Practice from here, not ranked.]`)
  if (d.phase === 'wait' || d.phase === 'call') {
    d.enterWait(true)
  } else if (d.phase === 'bossClock') {
    d.enterBossClock()
  }
}
