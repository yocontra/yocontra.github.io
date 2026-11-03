import type { Verdict } from './clock.ts'
import { coward, cowardFined, shotDown } from './defeat.ts'
import type { Director } from './director.ts'
import { killEnemyAnim, killRifleman, win } from './outcome.ts'
import { book, type Paid } from './purse.ts'

const LIVE = new Set(['wait', 'bossClock', 'call'])

/** Server targets on the underboss: 0 is the rooftop rifleman, 1 is Curly himself. */
const SERVER_RIFLEMAN = 0

/** Book a verdict the screen has already moved past (e.g. a stall loss arriving late). */
function bookOnly(d: Director, v: Verdict, paid: Paid): void {
  book(d, { outcome: v.outcome, reactionMs: v.reactionMs }, paid)
  d.c.hud.setPurse(v.purse, true)
}

/**
 * The underboss shot you. If your first shot dropped one of them, the other
 * one fired: drop whoever you hit, and return who shot you (0 = Curly, 1 = the rifleman).
 */
function underbossShooter(d: Director, v: Verdict): number {
  if (v.targetsHit === 0) {
    // nobody down: the rifleman draws first (330 ms against Curly's 560)
    return 1
  }
  if (d.firstTarget === SERVER_RIFLEMAN) {
    killRifleman(d)
    return 0
  }
  d.enemyAlive = false
  killEnemyAnim(d)
  return 1
}

function onLoss(d: Director, v: Verdict, paid: Paid): void {
  if (!LIVE.has(d.phase)) {
    bookOnly(d, v, paid)
    return
  }
  const who = d.underboss ? underbossShooter(d, v) : 0
  shotDown(d, who, paid)
}

function onWin(d: Director, v: Verdict, paid: Paid): void {
  if (d.phase !== 'call') {
    bookOnly(d, v, paid)
    return
  }
  killRifleman(d)
  d.enemyAlive = false
  d.lastReaction = v.reactionMs ?? d.lastReaction
  // boss phase one pays nothing (payout 0) and goes to the wound; phase two pays it all
  win(d, v.reactionMs ?? 0, paid)
}

/**
 * Ranked: the server's verdict is the authority. Play the kill cam, the death
 * or the back-shot to match, and take its payout and purse as given: the
 * client never computes a ranked purse.
 */
export function onVerdict(d: Director, v: Verdict): void {
  const paid = { payout: v.payout, purse: v.purse }
  if (v.duel !== d.duelId) {
    // a duel we already finished on screen (a stall): just book it
    bookOnly(d, v, paid)
    return
  }
  switch (v.outcome) {
    case 'coward':
      if (d.phase !== 'coward') {
        // shot after the call, but faster than a human can react: the server calls it a guess
        coward(d, d.phase === 'call' ? 'Too quick to be a reaction. That was a guess.' : '')
      }
      cowardFined(d, paid)
      break
    case 'loss':
      onLoss(d, v, paid)
      break
    default:
      onWin(d, v, paid)
      break
  }
}

/** The ranked connection is gone (or the server disagreed): carry on in practice from here. */
export function onDropped(d: Director, reason: string): void {
  if (!d.ranked) {
    return
  }
  d.setPractice(`[${reason} Practice from here, not ranked.]`)
  if (!LIVE.has(d.phase)) {
    return
  }
  // the standoff was the server's: run it again on the local clock
  if (d.boss && d.bossPhase === 1) {
    d.enterBossClock()
  } else {
    d.enterWait(true)
  }
}
