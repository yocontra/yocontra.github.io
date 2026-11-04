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
import { emptyStreet } from './mode.ts'

/** Forfeits, dodges, freezes and double dead heats: no kill cam, a caption and the fall. */
export function quietEndFx(d: Director, r: DuelResult, seat: Seat, lost: boolean): void {
  const mine = r.culprit === seat
  const caption: Record<string, string> = {
    froze: 'NO ONE DREW',
    draw: 'TIE',
    forfeit: mine ? 'FORFEIT' : 'HE LEFT',
    dodge: mine ? 'DODGED' : 'HE DODGED',
  }
  d.c.hud.call(lost ? 'OVER' : (caption[r.outcome] ?? 'OVER'), 1600)
  d.c.audio.heartbeat(0)
  // he lit out or dodged: still a win; you did: a loss. Freezes and draws get no sting.
  if (!lost && r.winner === seat) {
    d.c.audio.playSting('victory')
  } else if (!lost && r.culprit === seat) {
    d.c.audio.playSting('defeat')
  }
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
  o: {
    name: string
    xp: { before: number | null; after: number | null }
    lost: string | null
    /** The verdict came in a rejoin's sync, which carries no per-seat money lines. */
    synced: boolean
  },
): ResultView {
  const { lost } = o
  const view = resultView(r, seat, o.name, o.xp)
  if (lost === null) {
    return o.synced && r.you === null
      ? { ...view, pending: 'Settled while you were away. See your ledger.' }
      : view
  }
  return {
    ...view,
    tone: 'even',
    title: 'Connection lost',
    sub: lost,
    canRematch: false,
    pending: 'Any result is in your ledger.',
  }
}

/**
 * "Flee?": a dodge before the walk, a forfeit after. Against a ghost (or a Town Outlaw) the room
 * closes before the walk with no fine.
 */
export function confirmFlee(d: Director, human: boolean): Promise<boolean> {
  const before = d.phase === 'cock' || d.phase === 'title'
  let body = 'Leaving now counts as a loss, with the full penalty.'
  if (before) {
    body = human
      ? 'Leaving now is a dodge: half penalty and no XP.'
      : 'No penalty for leaving a ghost duel now.'
  }
  return confirmSheet(d.c.hud.root, {
    title: 'Leave the duel?',
    body,
    yes: 'Leave',
    no: 'Stay',
    danger: true,
  })
}

/** Hand the street back to single player: local clock, the real save, an empty street. */
export function clearStreet(d: Director, realSave: SaveData): void {
  d.hooks = null
  d.clock = new LocalDuelClock(d.events) satisfies DuelClock
  d.c.save = realSave
  persist(realSave)
  d.c.hud.root.classList.remove('ow-pvp')
  d.c.world.poster.visible = true
  emptyStreet(d)
}
