/**
 * The ends of a Bounty Hunt match: the quiet endings (no kill cam), the results sheet's view
 * (including the honest "the line went dead" when the room vanished before its verdict), the flee
 * confirmation, and putting the street back for single player on the way out.
 */
import type { DuelResult, Seat } from '../contract/duel.ts'
import { save as persist, type SaveData } from '../save.ts'
import { type ResultView, resultView } from '../ui/results.ts'
import { confirmSheet } from '../ui/sheet.ts'
import { type DuelClock, LocalDuelClock } from './clock.ts'
import type { Director } from './director.ts'
import { titleShot } from './framing.ts'

/** Forfeits, dodges, freezes and double dead heats: no kill cam, a caption and the fall. */
export function quietEndFx(d: Director, r: DuelResult, seat: Seat, lost: boolean): void {
  const mine = r.culprit === seat
  const caption: Record<string, string> = {
    froze: 'BOTH FROZE',
    draw: 'DRAW',
    forfeit: mine ? 'FORFEIT' : 'HE LIT OUT',
    dodge: mine ? 'DODGED' : 'HE DODGED',
  }
  d.c.hud.call(lost ? 'OVER' : (caption[r.outcome] ?? 'OVER'), 1600)
  d.c.audio.heartbeat(0)
  d.enter('lose')
}

/** A stand-in verdict when the room went away before sending one: we don't know who won. */
export function lostResult(draw: number): DuelResult {
  return {
    type: 'result',
    serverTime: Date.now(),
    matchId: '',
    draw,
    outcome: 'forfeit',
    winner: null,
    culprit: null,
    reactions: [null, null],
    deadHeats: 0,
    you: null,
    settled: false,
  }
}

/** The results sheet's view; `lost` is the reason the room vanished, if it did. */
export function endView(
  r: DuelResult,
  seat: Seat,
  o: { name: string; xp: { before: number | null; after: number | null }; lost: string | null },
): ResultView {
  const { lost } = o
  const view = resultView(r, seat, o.name, o.xp)
  if (lost === null) {
    return view
  }
  return {
    ...view,
    tone: 'even',
    title: 'The line went dead',
    sub: lost,
    canRematch: false,
    pending: 'Whatever the room settled is in your ledger.',
  }
}

/** "Flee?": a dodge before the walk, a forfeit after. */
export function confirmFlee(d: Director): Promise<boolean> {
  const before = d.phase === 'cock' || d.phase === 'title'
  return confirmSheet(d.c.hud.root, {
    title: 'Flee?',
    body: before
      ? 'Running before the walk is a dodge: half your penalty and no XP.'
      : 'Running now is a forfeit: a loss with the full penalty.',
    yes: 'Flee',
    no: 'Stand your ground',
    danger: true,
  })
}

/** Hand the street back to single player: local clock, the real save, an empty street. */
export function clearStreet(d: Director, realSave: SaveData): void {
  d.hooks = null
  d.clock = new LocalDuelClock(d.events) satisfies DuelClock
  d.c.save = realSave
  persist(realSave)
  d.enemy?.dispose()
  d.enemy = null
  d.c.physics.clear()
  const hud = d.c.hud
  hud.root.classList.remove('ow-pvp')
  hud.hideCard()
  hud.clearCall()
  hud.clearCaptions()
  hud.letterbox(false)
  hud.show(false)
  d.c.audio.heartbeat(0)
  d.timeScale = 1
  d.player.root.visible = false
  d.enter('title')
  titleShot(d)
}
