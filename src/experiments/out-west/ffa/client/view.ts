/**
 * View-dependent rendering policy and weapon numbers for the shooter HUD.
 *
 * Looking along the street shows the whole town and the horizon, where top-down never saw past
 * ~40 m. So the shooter views get a real draw distance with fog that melts the far end into the
 * sky colour (aerial perspective in the late-afternoon haze), tiered hard: the floor tier (the
 * iPhone 13 mini) sees 120 m with fog from 38 m, legacy 90 m; desktop 230 m. The sun's shadow box
 * follows the view: it sits ahead of you, where you look, and grows with the tier.
 */
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'
import type { Quality } from '../../engine/tiers.ts'
import {
  REVOLVER_FIRE_MS,
  RIFLE_FIRE_MS,
  RIFLE_SPREAD_MOVING_DEG,
  RIFLE_SPREAD_STANDING_DEG,
  SHOTGUN_CONE_DEG,
  SHOTGUN_FIRE_MS,
  SPREAD_MOVING_DEG,
  SPREAD_STANDING_DEG,
} from '../sim/constants.ts'
import type { ViewMode } from './settings.ts'

export interface ViewPolicy {
  /** Camera far plane (m). */
  far: number
  /** Linear fog (m). */
  fogNear: number
  fogFar: number
  /** Sun shadow box half-size (m), and how far ahead of you it centres. */
  shadowHalf: number
  shadowAhead: number
}

const TOP: ViewPolicy = { far: 160, fogNear: 120, fogFar: 260, shadowHalf: 12, shadowAhead: 0 }

const SHOOTER: Record<Quality, ViewPolicy> = {
  high: { far: 230, fogNear: 70, fogFar: 225, shadowHalf: 24, shadowAhead: 14 },
  medium: { far: 190, fogNear: 60, fogFar: 185, shadowHalf: 20, shadowAhead: 12 },
  floor: { far: 120, fogNear: 38, fogFar: 118, shadowHalf: 12, shadowAhead: 7 },
  legacy: { far: 90, fogNear: 28, fogFar: 88, shadowHalf: 10, shadowAhead: 6 },
}

export function policyFor(mode: ViewMode, tier: Quality): ViewPolicy {
  return mode === 'top' ? TOP : SHOOTER[tier]
}

/** The sim's spread for this weapon and gait (degrees, full cone half-angle). */
export function spreadDeg(weapon: number, moving: boolean, deadEye: boolean): number {
  if (deadEye) {
    return 0
  }
  if (weapon === WEAPON_SHOTGUN) {
    return SHOTGUN_CONE_DEG / 2
  }
  if (weapon === WEAPON_RIFLE) {
    return moving ? RIFLE_SPREAD_MOVING_DEG : RIFLE_SPREAD_STANDING_DEG
  }
  return moving ? SPREAD_MOVING_DEG : SPREAD_STANDING_DEG
}

/** Hold-to-fire repeat interval (ms): the gun's own rate plus a tick of margin. */
export function fireIntervalMs(weapon: number): number {
  if (weapon === WEAPON_SHOTGUN) {
    return SHOTGUN_FIRE_MS + 50
  }
  if (weapon === WEAPON_RIFLE) {
    return RIFLE_FIRE_MS + 50
  }
  return REVOLVER_FIRE_MS + 50
}

/** Degrees of spread → crosshair gap in CSS px at this vertical FOV and viewport height. */
export function spreadPx(deg: number, fovDeg: number, height: number): number {
  const t = Math.tan((deg * Math.PI) / 180) / Math.tan((fovDeg * Math.PI) / 360)
  return (t * height) / 2
}
