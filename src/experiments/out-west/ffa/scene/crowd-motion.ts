/**
 * Frontier crowd motion: gait selection with hysteresis, the authored clip speeds, and the far
 * rider's stance clip. Pure functions of the simulated player, shared by the near and far paths.
 */
import type { Color, Object3D } from 'three'
import {
  ANIM_AIM,
  ANIM_DEAD,
  ANIM_SLIDE,
  EF_HOLSTERED,
  STANCE_ADS,
  STANCE_CROUCH,
  STANCE_SPRINT,
} from '../../contract/town.ts'
import type { Clip } from '../../scene/actor.ts'
import type { CrowdPlayer } from './crowd.ts'
import type { PlayerLook } from './looks.ts'

/** Running speed the Run clip was authored for (m/s). */
export const CLIP_RUN_SPEED = 5.2
/** Walking speed the Walk clip was authored for (m/s), until an actor measures his stride. */
export const CLIP_WALK_SPEED = 1.4
/**
 * Gait thresholds on the smoothed ground speed (m/s), with hysteresis so a rider near a boundary
 * doesn't flicker between clips: idle below `WALK_ON` (back to idle under `WALK_OFF`), walk up to
 * `RUN_ON` (back from a run under `RUN_OFF`). A full stick runs at 5.5 m/s.
 */
export const WALK_ON = 0.45
export const WALK_OFF = 0.25
export const RUN_ON = 2.6
export const RUN_OFF = 2.1
export const GAIT_IDLE = 0
export const GAIT_WALK = 1
export const GAIT_RUN = 2

export function setAuto(bones: readonly Object3D[], on: boolean): void {
  for (const b of bones) {
    b.matrixAutoUpdate = on
  }
}

/** Idle, walk or run at this ground speed, from the last gait (-1: none yet), with hysteresis. */
export function nextGait(gait: number, v: number): number {
  if (gait === GAIT_IDLE && v < WALK_ON) {
    return GAIT_IDLE
  }
  if (gait !== GAIT_IDLE && v < WALK_OFF) {
    return GAIT_IDLE
  }
  if (gait < 0 && v < WALK_ON) {
    return GAIT_IDLE
  }
  if (gait === GAIT_RUN) {
    return v < RUN_OFF ? GAIT_WALK : GAIT_RUN
  }
  return v >= RUN_ON ? GAIT_RUN : GAIT_WALK
}

/** Playback rate of a gait clip at this ground speed, so the feet roughly keep to the ground. */
export function gaitRate(clip: Clip, speed: number, walk: number): number {
  return clip === 'Walk'
    ? Math.max(0.6, Math.min(1.6, speed / walk))
    : Math.max(0.6, Math.min(1.3, speed / CLIP_RUN_SPEED))
}

/** A far rider's clip for his stance: the crouch, the sprint, the slide, the sights, his death. */
export function farStance(p: CrowdPlayer, gait: Clip, has: (c: Clip) => boolean): Clip {
  if (p.anim === ANIM_DEAD) {
    return 'Death'
  }
  if (p.anim === ANIM_SLIDE && has('Crouch_Idle')) {
    return 'Crouch_Idle'
  }
  if ((p.stance & STANCE_CROUCH) !== 0 && has('Crouch_Idle')) {
    return gait === 'Idle' ? 'Crouch_Idle' : 'Crouch_Walk'
  }
  if ((p.stance & STANCE_SPRINT) !== 0 && has('Sprint')) {
    return 'Sprint'
  }
  const drawn = !(p.flags & EF_HOLSTERED) || (p.stance & STANCE_ADS) !== 0
  if (p.anim === ANIM_AIM || (p.stance & STANCE_ADS) !== 0 || (gait === 'Idle' && drawn)) {
    return gait === 'Idle' || (p.stance & STANCE_ADS) !== 0 ? 'Idle_Gun_Pointing' : gait
  }
  return gait
}

const hatColors = new WeakMap<PlayerLook, Color>()
export function hatColor(look: PlayerLook): Color {
  let c = hatColors.get(look)
  if (!c) {
    c = look.top.clone().setHex(look.hatColor)
    hatColors.set(look, c)
  }
  return c
}
