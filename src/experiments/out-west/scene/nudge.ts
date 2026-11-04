/**
 * The small procedural nudges on top of a duellist's clip (scene/actor.ts): the drunk's sway,
 * the shaky man's trembling gun hand, a startled twitch of the arm, and the rooftop rifle's kick
 * settling after a shot.
 */
import type { Bone } from 'three'

export interface Nudged {
  sway: number
  shake: number
  twitch: number
  longKick: number
  readonly spine: Bone | null
  readonly forearmR: Bone | null
  readonly armR: Bone | null
}

/** Layer the nudges for this frame (`t` is his own clock); returns false once the kick settles. */
export function nudge(a: Nudged, t: number, dt: number, kickDecays: boolean): boolean {
  if (a.sway > 0 && a.spine) {
    a.spine.rotation.z += Math.sin(t * 1.3) * 0.12 * a.sway
    a.spine.rotation.x += Math.sin(t * 0.9 + 1) * 0.06 * a.sway
  }
  if (a.shake > 0 && a.forearmR) {
    a.forearmR.rotation.x += (Math.random() - 0.5) * 0.08 * a.shake
    a.forearmR.rotation.z += (Math.random() - 0.5) * 0.08 * a.shake
  }
  if (a.twitch > 0.001 && a.armR) {
    a.armR.rotation.z += Math.sin(t * 40) * 0.12 * a.twitch
    a.armR.rotation.x += 0.15 * a.twitch
    a.twitch = Math.max(0, a.twitch - dt * 3)
  }
  if (!kickDecays) {
    return false
  }
  a.longKick *= Math.exp(-dt / 0.12)
  if (a.longKick < 0.005) {
    a.longKick = 0
    return false
  }
  return true
}
