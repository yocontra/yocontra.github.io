/**
 * Haptics (spec §11.1). `navigator.vibrate` on Android Chrome, the bridge inside the app, and a
 * silent no-op on iOS Safari (unsupported there).
 *
 * **Never call this for the call ("DRAW!") or a fake-out.** Touch reaction is faster than audio,
 * so a buzz on the call would be an unfair cue, and desktop players have no motor. The type only
 * admits the player's own shot, being hit, and an optional heartbeat. Owned by stream A.
 */
import { type HapticKind, isIOS, platform } from './bridge.ts'

/** Milliseconds (or a pattern) per kind, within the spec's 15–30 ms. */
const PATTERNS: Readonly<Record<HapticKind, number | number[]>> = {
  shot: 18,
  hit: [30, 40, 20],
  beat: 15,
}

let enabled = true

/** Player setting ("Vibration"). */
export function setHapticsEnabled(on: boolean): void {
  enabled = on
}

export const hapticsEnabled = (): boolean => enabled

/** True when a buzz can actually happen here (for showing the setting at all). */
export function hapticsSupported(): boolean {
  if (platform.kind !== 'web') {
    return true
  }
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' && !isIOS()
}

/** Buzz for the player's own shot, a hit, or a heartbeat. Safe to call anywhere; never throws. */
export function haptic(kind: HapticKind): void {
  if (!enabled) {
    return
  }
  if (platform.kind !== 'web') {
    platform.haptic(kind)
    return
  }
  if (!hapticsSupported()) {
    return
  }
  try {
    navigator.vibrate(PATTERNS[kind])
  } catch {
    // some browsers throw without a recent user gesture; a missed buzz is fine
  }
}
