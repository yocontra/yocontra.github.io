/**
 * Pause and resume hooks (spec §11.1). Fires once per transition, from whichever signal arrives
 * first: `visibilitychange`, `pagehide`/`pageshow` (bfcache), `freeze`/`resume` (Chrome page
 * lifecycle) and the native bridge's `pause`/`resume` events. Owned by stream A.
 */
import { onNative } from './native.ts'

type Listener = () => void

const pauseListeners = new Set<Listener>()
const resumeListeners = new Set<Listener>()
let paused = typeof document !== 'undefined' && document.visibilityState === 'hidden'
let installed = false

function emit(nextPaused: boolean): void {
  if (paused === nextPaused) {
    return
  }
  paused = nextPaused
  for (const cb of nextPaused ? pauseListeners : resumeListeners) {
    try {
      cb()
    } catch (err) {
      console.error('lifecycle listener failed', err)
    }
  }
}

function install(): void {
  if (installed || typeof document === 'undefined') {
    return
  }
  installed = true
  document.addEventListener('visibilitychange', () => emit(document.visibilityState === 'hidden'))
  globalThis.addEventListener('pagehide', () => emit(true))
  globalThis.addEventListener('pageshow', () => emit(document.visibilityState === 'hidden'))
  document.addEventListener('freeze', () => emit(true))
  document.addEventListener('resume', () => emit(document.visibilityState === 'hidden'))
  onNative('pause', () => emit(true))
  onNative('resume', () => emit(false))
}

/** True while the page is hidden or the app is backgrounded. */
export const isPaused = (): boolean => paused

/** Called when the page goes to the background. Returns an unsubscribe. */
export function onPause(cb: Listener): () => void {
  install()
  pauseListeners.add(cb)
  return () => pauseListeners.delete(cb)
}

/** Called when the page comes back. Returns an unsubscribe. */
export function onResume(cb: Listener): () => void {
  install()
  resumeListeners.add(cb)
  return () => resumeListeners.delete(cb)
}
