/**
 * The menus' sounds, in one place. `installUiSounds` binds the page's audio engine once; after
 * that:
 *
 * - every `<button>` press ticks (one capture-phase listener, so it works even where a handler
 *   stops propagation; touch sticks are not buttons and stay silent),
 * - paper sliding in (`ow-paper-in`, the duel card) rustles and every slam (`ow-stamp`: stamps,
 *   seals, the posters) thumps, on the frame its animation actually starts,
 * - purchases, level-ups, a found match and the ghost have their own cues (`uiSound`).
 *
 * The engine hushes all of it through a standoff and under the call (`AudioEngine.hushUi`), and
 * nothing here uses a bell or chime timbre, so no menu sound can ever be mistaken for the call.
 */
import type { AudioEngine, UiName } from '../audio/audio.ts'

let engine: AudioEngine | null = null
/** The level last announced (null until the first profile arrives, which never plays). */
let knownLevel: number | null = null

/** Which sound a starting animation makes. Posters slam in but sound like paper, not a stamp. */
function animationSound(e: AnimationEvent): UiName | null {
  const t = e.target
  if (!(t instanceof HTMLElement)) {
    return null
  }
  if (e.animationName === 'ow-paper-in') {
    return 'uiPaper'
  }
  if (e.animationName === 'ow-stamp') {
    return t.classList.contains('ow-wanted') ? 'uiPaper' : 'uiStamp'
  }
  return null
}

/** Bind the page's engine and listen for presses and slides (idempotent). */
export function installUiSounds(audio: AudioEngine): void {
  const first = engine === null
  engine = audio
  if (!first || typeof document === 'undefined') {
    return
  }
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target
      const b = t instanceof Element ? t.closest('button') : null
      if (b && !b.disabled && !b.closest('[data-silent]')) {
        engine?.ui('uiTick')
      }
    },
    { capture: true, passive: true },
  )
  document.addEventListener(
    'animationstart',
    (e) => {
      const name = animationSound(e)
      if (name) {
        engine?.ui(name)
      }
    },
    { capture: true, passive: true },
  )
}

/** Play a menu cue (no-op before `installUiSounds`, and hushed through a standoff). */
export function uiSound(name: UiName): void {
  engine?.ui(name)
}

/**
 * A level reached: plays `levelUp` once per new level. The first level seen (or `from`, the level
 * before a match) is the baseline and never plays, so a page load or a profile refresh after the
 * results sheet already announced it stays quiet.
 */
export function announceLevel(level: number, from: number | null = null): void {
  const base = knownLevel ?? from
  if (base !== null && level > base) {
    uiSound('levelUp')
  }
  knownLevel = Math.max(level, knownLevel ?? level)
}
