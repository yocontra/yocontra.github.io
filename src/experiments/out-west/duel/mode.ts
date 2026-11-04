import { save as persist, resetRun } from '../save.ts'
import { LocalDuelClock } from './clock.ts'
import type { Director } from './director.ts'
import { titleShot } from './framing.ts'
import { ambience } from './present.ts'
import { RankedDuelClock } from './ranked-clock.ts'
import { standoffSpec } from './standoff.ts'

/**
 * Ranked or practice. A run is ranked only when it starts fresh at outlaw 1
 * with a server session in hand; anything going wrong after that drops the
 * run to practice and the game carries on.
 */

const PRACTICE = 'Practice'

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
  const r = await connect().catch(() => ({ ok: false, error: '' }) as const)
  const session = r.ok ? r.value : null
  if (attempt !== d.rankedTry) {
    // a restart (or a drop to practice) superseded this attempt
    session?.close()
    return
  }
  if (!(session && canRank(d))) {
    session?.close()
    d.c.hud.setMode(PRACTICE)
    if (!r.ok && r.error) {
      // say why it isn't ranked (closed for the month, rate limited, unreachable)
      d.c.hud.fake(`[${r.error}]`, 6000)
    }
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

/** The street with nobody on it: the HUD cleared, his body gone, the title camera. */
export function emptyStreet(d: Director): void {
  const c = d.c
  d.enemy?.dispose()
  d.enemy = null
  d.rifleman?.dispose()
  d.rifleman = null
  d.dying = null
  d.fallers = []
  c.physics.clear()
  const hud = c.hud
  hud.hideCard()
  hud.clearCall()
  hud.clearCaptions()
  hud.letterbox(false)
  hud.show(false)
  c.audio.heartbeat(0)
  // back to the saloon's piano, undo any standoff duck, and let the bed rest
  c.audio.playSong('saloon')
  c.audio.musicLevel(0, 0.6)
  c.audio.musicLowpass(18_000, 0.6)
  ambience(d, 1, 1.5)
  d.timeScale = 1
  d.player.root.visible = false
  d.enter('title')
  titleShot(d)
}

/**
 * Pause → Saloon: walk off the street and back to the hub, no reload. The save keeps your outlaw,
 * so the hub offers to continue (as practice: a ranked session can't be picked up again).
 */
export function toSaloon(d: Director): void {
  const c = d.c
  d.paused = false
  d.pausedPhase = null
  c.hud.closeMenu()
  c.input.enabled = true
  c.audio.resume()
  d.bellVoice?.stop()
  d.bellVoice = null
  d.pianoVoice?.stop()
  d.pianoVoice = null
  d.board.close()
  c.hud.hideEnd()
  setPractice(d, '')
  d.duelId = -1
  d.standoffSent = false
  persist(c.save)
  emptyStreet(d)
  d.onSaloon?.()
}
