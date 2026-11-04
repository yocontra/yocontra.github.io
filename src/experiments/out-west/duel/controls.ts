import { FEEL } from '../data/feel.ts'
import type { Press } from '../engine/input.ts'
import { save as persist } from '../save.ts'
import { coward, lateDraw } from './defeat.ts'
import type { Director } from './director.ts'
import { ensureStandoff, openBoard, restartRun, toSaloon } from './mode.ts'
import { playerShoots } from './standoff.ts'
import type { Phase } from './state.ts'

/** Player input: what a press means in each phase, and the pause menu. */

function skipIntro(d: Director): void {
  if (d.phase === 'intro' && d.skipIntroAllowed) {
    d.startLevel(d.c.save.level, false)
  }
}

function retryAfterPress(d: Director, p: Press): void {
  if (d.phaseT > FEEL.loseRetryPress) {
    d.retry()
    return
  }
  // practice: the press that came just too late goes on the lose card
  if (d.phase === 'lose' && !d.ranked) {
    lateDraw(d, p)
  }
}

/**
 * A press that can't be a back-shot yet: just after a retry, and as the wait opens. It is held,
 * and "steady…" says so, rather than fined.
 */
function steadying(d: Director, p: Press): boolean {
  if (p.t >= d.steadyUntil) {
    return false
  }
  d.c.hud.fake('steady…', Math.max(300, d.steadyUntil - p.t))
  return true
}

/** Drew before the call. Ranked: the server judges it too (and fines it). */
function cowardNow(d: Director, p: Press): void {
  if (steadying(d, p)) {
    return
  }
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
      cowardNow(d, p)
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
  pauseMenu(d)
}

/**
 * Leaving a ranked run (to the saloon, or a restart) ends it for good: say so first, and offer to
 * bank what it has earned. Practice leaves at once.
 */
function leaveRanked(d: Director, go: () => void): void {
  if (!d.ranked) {
    go()
    return
  }
  const banked = d.c.save.run.total > 0
  d.c.hud.menuConfirm({
    title: 'Quit this ranked run?',
    body: `You can’t resume a ranked run. The rest will be practice.${banked ? ' Submit it first to put your score on the board.' : ''}`,
    no: { label: 'Keep playing', run: () => pauseMenu(d) },
    ...(banked ? { extra: { label: 'Submit run', run: () => openBoard(d, false) } } : {}),
    yes: { label: 'Quit run', run: go },
  })
}

function pauseMenu(d: Director): void {
  const c = d.c
  c.hud.openMenu(c.save.settings, {
    resume: () => togglePause(d),
    change: (s) => {
      c.save.settings = s
      persist(c.save)
      applySettings(d)
    },
    restart: () =>
      leaveRanked(d, () => {
        togglePause(d)
        restartRun(d, c.save.legend)
      }),
    ...(d.onSaloon ? { saloon: () => leaveRanked(d, () => toSaloon(d)) } : {}),
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
