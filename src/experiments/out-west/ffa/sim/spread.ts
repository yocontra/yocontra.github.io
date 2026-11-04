/**
 * Hip fire versus the sights (wire v5), shared by the server's shots and the client's crosshair:
 * each gun's base spread from the hip or on the sights, scaled by how you move, plus bloom from
 * recent shots. The shotgun's number is its cone (full width); the others are the half-angle a
 * shot may stray by.
 */
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'
import {
  BLOOM_DECAY_DEG,
  MAX_BLOOM_DEG,
  REVOLVER_ADS_DEG,
  REVOLVER_BLOOM_DEG,
  REVOLVER_HIP_DEG,
  RIFLE_ADS_DEG,
  RIFLE_BLOOM_DEG,
  RIFLE_HIP_DEG,
  SHOTGUN_ADS_CONE_DEG,
  SHOTGUN_CONE_DEG,
  SPREAD_AIR_DEG,
  SPREAD_AIR_K,
  SPREAD_CROUCH_K,
  SPREAD_MOVING_K,
  SPREAD_SLIDE_K,
} from './constants.ts'

export interface SpreadInput {
  weapon: number
  ads: boolean
  crouched: boolean
  moving: boolean
  sliding: boolean
  airborne: boolean
  /** Degrees of bloom from recent shots. */
  bloom: number
}

/** Spread in degrees for a shot right now. */
export function spreadDeg(s: SpreadInput): number {
  if (s.weapon === WEAPON_SHOTGUN) {
    // the pellet cone: tighter on the sights, never bloomed
    const cone = s.ads ? SHOTGUN_ADS_CONE_DEG : SHOTGUN_CONE_DEG
    return s.airborne ? cone * 1.3 : cone
  }
  const rifle = s.weapon === WEAPON_RIFLE
  let base: number
  if (s.ads) {
    base = rifle ? RIFLE_ADS_DEG : REVOLVER_ADS_DEG
  } else {
    base = rifle ? RIFLE_HIP_DEG : REVOLVER_HIP_DEG
  }
  let k = 1
  if (s.airborne) {
    k = SPREAD_AIR_K
  } else if (s.sliding) {
    k = SPREAD_SLIDE_K
  } else if (s.moving) {
    k = SPREAD_MOVING_K
  } else if (s.crouched) {
    k = SPREAD_CROUCH_K
  }
  return base * k + (s.airborne ? SPREAD_AIR_DEG : 0) + s.bloom * (s.ads ? 0.5 : 1)
}

/** Bloom after one more shot of this weapon. */
export function bloomAfterShot(weapon: number, bloom: number): number {
  if (weapon === WEAPON_SHOTGUN) {
    return bloom
  }
  return Math.min(
    MAX_BLOOM_DEG,
    bloom + (weapon === WEAPON_RIFLE ? RIFLE_BLOOM_DEG : REVOLVER_BLOOM_DEG),
  )
}

/** Bloom one tick later. */
export const settleBloom = (bloom: number): number => Math.max(0, bloom - BLOOM_DECAY_DEG)
