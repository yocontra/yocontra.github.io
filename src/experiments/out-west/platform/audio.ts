/**
 * Mobile audio unlock (spec §11.1):
 *
 * - Resumes the `AudioContext` inside the first `pointerup`/`touchend`/`keydown` (iOS only allows
 *   it there), and plays one silent sample so old WebKit fully unlocks.
 * - Handles `state === 'interrupted'` (a call, Siri) by resuming on the next gesture.
 * - Suspends while the page is hidden, and resumes when it comes back (or on the next gesture if
 *   the browser refuses).
 * - Sets `navigator.audioSession.type` to `'ambient'` (respects the silent switch) or, with the
 *   "Play sound on silent" setting, `'playback'`.
 *
 * The DRAW! caption is always shown, so silence never decides a duel. Owned by stream A.
 */
import { onPause, onResume } from './lifecycle.ts'

export type AudioSessionMode = 'ambient' | 'playback'

interface AudioSessionLike {
  type: string
}

const GESTURES = ['pointerup', 'touchend', 'keydown', 'click'] as const

/** Applies the iOS audio session type where supported (Safari 17+). No-op elsewhere. */
export function setAudioSessionMode(mode: AudioSessionMode): void {
  const session: unknown = Reflect.get(navigator, 'audioSession')
  if (typeof session === 'object' && session !== null && 'type' in session) {
    try {
      ;(session as AudioSessionLike).type = mode
    } catch {
      // read-only in some builds
    }
  }
}

function playSilence(ctx: AudioContext): void {
  try {
    const src = ctx.createBufferSource()
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
    src.connect(ctx.destination)
    src.start(0)
  } catch {
    // harmless
  }
}

export interface AudioUnlock {
  /** True once a gesture has resumed the context at least once. */
  readonly unlocked: boolean
  dispose: () => void
}

/**
 * Keeps `ctx` running whenever the page is visible and the player has touched it. Call once at
 * boot with the game's single AudioContext.
 */
export function unlockAudio(
  ctx: AudioContext,
  opts: { mode?: AudioSessionMode; onUnlock?: () => void } = {},
): AudioUnlock {
  setAudioSessionMode(opts.mode ?? 'ambient')
  let unlocked = false
  let hidden = document.visibilityState === 'hidden'
  let armed = false

  const needsGesture = (): boolean => ctx.state !== 'running' && !hidden

  const onGesture = (): void => {
    if (hidden) {
      return
    }
    void ctx.resume().then(() => {
      if (ctx.state !== 'running') {
        return
      }
      if (!unlocked) {
        unlocked = true
        playSilence(ctx)
        opts.onUnlock?.()
      }
      disarm()
    })
  }

  const arm = (): void => {
    if (armed) {
      return
    }
    armed = true
    for (const ev of GESTURES) {
      globalThis.addEventListener(ev, onGesture, { capture: true, passive: true })
    }
  }

  function disarm(): void {
    armed = false
    for (const ev of GESTURES) {
      globalThis.removeEventListener(ev, onGesture, { capture: true })
    }
  }

  // 'interrupted' (iOS) and 'suspended' both mean: wait for the next gesture.
  const onStateChange = (): void => {
    if (needsGesture()) {
      arm()
    }
  }
  ctx.addEventListener('statechange', onStateChange)

  const offPause = onPause(() => {
    hidden = true
    if (ctx.state === 'running') {
      void ctx.suspend()
    }
  })
  const offResume = onResume(() => {
    hidden = false
    if (!unlocked) {
      arm()
      return
    }
    void ctx
      .resume()
      .catch(() => undefined)
      .then(onStateChange)
  })

  if (needsGesture() || ctx.state !== 'running') {
    arm()
  } else {
    unlocked = true
  }

  return {
    get unlocked() {
      return unlocked
    },
    dispose() {
      disarm()
      ctx.removeEventListener('statechange', onStateChange)
      offPause()
      offResume()
    },
  }
}
