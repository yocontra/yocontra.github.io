import { save as persist, resetRun } from '../save.ts'
import { LocalDuelClock } from './clock.ts'
import type { Director } from './director.ts'
import { RankedDuelClock } from './ranked-clock.ts'
import { standoffSpec } from './standoff.ts'

/**
 * Ranked or practice. A run is ranked only when it starts fresh at outlaw 1
 * with a server session in hand; anything going wrong after that drops the
 * run to practice and the game carries on.
 */

const PRACTICE = 'PRACTICE · not ranked'

export function setPractice(d: Director, note: string): void {
  d.rankedTry++
  d.clock.dispose()
  d.clock = new LocalDuelClock(d.events)
  d.c.hud.setMode(PRACTICE)
  if (note) {
    d.c.hud.fake(note, 4000)
  }
}

/** Only a fresh, normal run, before its first standoff, can become ranked. */
function canRank(d: Director): boolean {
  return !d.c.save.legend && d.level === 0 && d.duelId < 0 && !d.standoffSent
}

/**
 * Try to make this run ranked: a fresh Turnstile token and a fresh session
 * every time. Stays in practice if anything fails, or if the run has moved on
 * (or been restarted) by the time the session opens.
 */
export async function tryRanked(d: Director): Promise<void> {
  const connect = d.connectRanked
  if (!(connect && canRank(d))) {
    d.c.hud.setMode(PRACTICE)
    return
  }
  d.rankedTry++
  const attempt = d.rankedTry
  d.c.hud.setMode('connecting…')
  const session = await connect().catch(() => null)
  if (attempt !== d.rankedTry) {
    // a restart (or a drop to practice) superseded this attempt
    session?.close()
    return
  }
  if (!(session && canRank(d))) {
    session?.close()
    d.c.hud.setMode(PRACTICE)
    return
  }
  d.clock.dispose()
  d.clock = new RankedDuelClock(session, d.events)
  d.c.save.run = { version: 1, duels: [], total: 0 }
  persist(d.c.save)
  d.c.hud.setPurse(0, false)
  d.c.hud.setMode('RANKED')
}

/** Ranked: make sure the server has this attempt's standoff (a stall or an early shot). */
export function ensureStandoff(d: Director): void {
  if (!d.standoffSent) {
    d.standoffSent = true
    d.duelId = d.clock.standoff(standoffSpec(d))
  }
}

/** The leaderboard: bank a ranked run with a name, or just look. */
export function openBoard(d: Director, fromEnd: boolean): void {
  const clock = d.clock
  const total = d.c.save.run.total
  if (clock instanceof RankedDuelClock && total > 0) {
    d.board.open({
      purse: total,
      submitLabel: fromEnd ? 'Submit to leaderboard' : 'Bank this run and end it',
      submit: async (name) => {
        const r = await clock.bank(name)
        if (r.ok && !fromEnd) {
          setPractice(d, '[Run banked. Practice from here.]')
        }
        return r
      },
    })
    return
  }
  d.board.open({
    note: d.ranked ? 'Earn a bounty to get on the board.' : 'Practice runs aren’t ranked.',
  })
}

/** A fresh gauntlet (pause → restart, or play again): ranked again if possible. */
export function restartRun(d: Director, legend: boolean): void {
  const c = d.c
  d.board.close()
  c.hud.hideEnd()
  c.hud.show(true)
  resetRun(c.save, legend)
  persist(c.save)
  c.hud.setPurse(0, false)
  setPractice(d, '')
  d.duelId = -1
  d.standoffSent = false
  // level 0 before asking, so the session isn't refused for the run that just ended
  d.level = 0
  tryRanked(d).catch(() => undefined)
  d.startLevel(0, false)
}
