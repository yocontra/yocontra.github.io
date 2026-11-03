import { FEEL } from '../data/feel.ts'
import type { Press } from '../engine/input.ts'
import { save as persist } from '../save.ts'
import { coward } from './defeat.ts'
import type { Director } from './director.ts'
import { ensureStandoff, openBoard, restartRun } from './mode.ts'
import { playerShoots } from './standoff.ts'
import type { Phase } from './state.ts'

/** Player input: what a press means in each phase, and the pause menu. */

function skipIntro(d: Director): void {
  if (d.phase === 'intro' && d.skipIntroAllowed) {
    d.startLevel(d.c.save.level, false)
  }
}

function retryAfterPress(d: Director): void {
  if (d.phaseT > FEEL.loseRetryPress) {
    d.retry()
  }
}

/** Drew before the call. Ranked: the server judges it too (and fines it). */
function cowardNow(d: Director): void {
  if (d.ranked) {
    ensureStandoff(d)
    d.clock.shot(0, null)
  }
  coward(d, '')
}

const ON_FIRE: Partial<Record<Phase, (d: Director, p: Press) => void>> = {
  intro: skipIntro,
  poster: (d) => {
    if (d.phaseT > 0.25 && d.c.save.seenPosters.includes(d.level)) {
      d.phaseT = FEEL.posterDuration
    }
  },
  // pointer presses during the walk are walking; a fire key is a back-shot
  walk: (d, p) => {
    if (p.source === 'key') {
      cowardNow(d)
    }
  },
  turn: cowardNow,
  wait: cowardNow,
  bossClock: cowardNow,
  call: playerShoots,
  win: (d) => {
    if (d.phaseT > 0.9) {
      d.nextLevel()
    }
  },
  lose: retryAfterPress,
  coward: retryAfterPress,
}

export function onPress(d: Director, p: Press): void {
  if (p.action === 'pause') {
    if (d.phase !== 'title' && d.phase !== 'end') {
      togglePause(d)
    }
    return
  }
  if (d.paused || d.c.hud.menuOpen || d.board.isOpen) {
    return
  }
  switch (p.action) {
    case 'walk':
      skipIntro(d)
      break
    case 'retry':
      if (d.phase === 'lose' || d.phase === 'coward') {
        d.retry()
      }
      break
    case 'skip':
      if (d.phase === 'poster' && d.phaseT > 0.2) {
        d.phaseT = FEEL.posterDuration
      } else {
        skipIntro(d)
      }
      break
    default:
      ON_FIRE[d.phase]?.(d, p)
      break
  }
}

function resume(d: Director): void {
  const c = d.c
  d.paused = false
  c.hud.closeMenu()
  c.input.enabled = true
  c.audio.resume()
  const ph = d.pausedPhase
  d.pausedPhase = null
  // Practice: pausing voids the wait, a fresh W on resume, no scumming.
  // Ranked: the server's clock never stopped; its verdict stands.
  if (d.ranked) {
    return
  }
  if (ph === 'wait' || ph === 'call' || ph === 'turn') {
    d.clock.cancel()
    d.enterWait(true)
  } else if (ph === 'bossClock') {
    d.clock.cancel()
    d.enterBossClock()
  }
}

export function togglePause(d: Director): void {
  const c = d.c
  if (d.paused) {
    resume(d)
    return
  }
  d.paused = true
  d.pausedPhase = d.phase
  if (!d.ranked) {
    d.bellVoice?.stop()
    d.bellVoice = null
  }
  c.audio.heartbeat(0)
  c.input.enabled = false
  c.audio.suspend()
  c.hud.openMenu(c.save.settings, {
    resume: () => togglePause(d),
    change: (s) => {
      c.save.settings = s
      persist(c.save)
      applySettings(d)
    },
    restart: () => {
      togglePause(d)
      restartRun(d, c.save.legend)
    },
    leaderboard: () => openBoard(d, false),
    remap: (_a, done) => {
      c.input.capture = (code) => {
        c.input.capture = null
        done(code)
      }
    },
  })
}

export function applySettings(d: Director): void {
  const s = d.c.save.settings
  d.c.input.toggleWalk = s.toggleWalk
  d.c.input.keys = s.keys
  d.c.hud.captions = s.captions
  d.c.rig.reduced = s.reducedMotion
  d.c.audio.setMono(s.mono)
}
