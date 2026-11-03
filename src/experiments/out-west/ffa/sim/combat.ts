/**
 * The revolver: fire rate, six rounds, reload, spread, Dead-Eye, and the lag-compensated hitscan.
 * Server-authoritative: the client only predicts muzzle flash and tracers.
 */
import {
  BTN_AIM,
  BTN_FIRE,
  BTN_RELOAD,
  MAX_REWIND_MS,
  NONE,
  SHOT_DEAD_EYE,
  SHOT_HIT,
  SHOT_RANGE_UNIT,
  SHOT_WALL,
  WEAPON_REVOLVER,
} from '../../contract/town.ts'
import {
  DEAD_EYE_CLOSE_TICKS,
  DEAD_EYE_MULTIPLIER,
  DEAD_EYE_WINDOW_TICKS,
  FALLOFF_FACTOR,
  FALLOFF_RANGE,
  HOLSTER_TICKS,
  MAX_RANGE,
  PLAYER_RADIUS,
  RELOAD_TICKS,
  REVOLVER_DAMAGE,
  REVOLVER_FIRE_MS,
  REVOLVER_ROUNDS,
  SPREAD_MOVING_DEG,
  SPREAD_STANDING_DEG,
  TICK_MS,
} from './constants.ts'
import { applyDamage } from './death.ts'
import { BLOCK_SHOT, rayGrid } from './layout.ts'
import { aimRadians, radiansToAim } from './move.ts'
import { hashSigned } from './rng.ts'
import {
  HIST_ALIVE,
  HIST_IFRAMES,
  HIST_PROTECTED,
  HIST_SHOWDOWN,
  poseAt,
  type World,
} from './state.ts'
import type { Player } from './types.ts'

const REWIND_TICKS = MAX_REWIND_MS / TICK_MS
const DEG = Math.PI / 180
const AIM_SNAP_UNITS = 16_384

export const isHolstered = (w: World, p: Player): boolean =>
  w.tick - p.lastFireTick >= HOLSTER_TICKS && p.reloadTicks === 0

export const pressed = (buttons: number, prev: number, bit: number): boolean =>
  (buttons & bit) !== 0 && (prev & bit) === 0

/** Dead-Eye reticle: started by aiming from the holster, ready in the 150 ms window after it closes. */
export function deadEyeReady(w: World, p: Player): boolean {
  if (p.deadEyeStart < 0) {
    return false
  }
  const held = w.tick - p.deadEyeStart
  return held >= DEAD_EYE_CLOSE_TICKS && held < DEAD_EYE_CLOSE_TICKS + DEAD_EYE_WINDOW_TICKS
}

/** Reload and reticle bookkeeping that runs every tick before firing. */
export function updateWeapon(w: World, p: Player, buttons: number): void {
  p.fireCooldownMs -= TICK_MS
  if (p.reloadTicks > 0) {
    p.reloadTicks--
    if (p.reloadTicks === 0) {
      p.ammo = REVOLVER_ROUNDS
    }
  } else if (
    p.ammo < REVOLVER_ROUNDS &&
    (p.ammo === 0 || pressed(buttons, p.lastButtons, BTN_RELOAD))
  ) {
    p.reloadTicks = RELOAD_TICKS
    p.deadEyeStart = -1
  }
  const aiming = (buttons & BTN_AIM) !== 0
  if (!aiming) {
    p.deadEyeStart = -1
  } else if (p.deadEyeStart < 0 && isHolstered(w, p)) {
    p.deadEyeStart = w.tick
  }
}

export interface ShotResult {
  target: number
  range: number
  deadEye: boolean
  killed: boolean
}

/** Clamp the client's claimed view time to the rewind window and the recorded history. */
export function rewindTime(w: World, viewTime: number): number {
  const latest = w.tick - 1
  return Math.max(latest - REWIND_TICKS, Math.min(latest, viewTime))
}

/** One landed shot: who, at which rewound `time`, for how much, and the shooter's `aim`. */
export interface Strike {
  targetId: number
  time: number
  damage: number
  deadEye: boolean
  aim: number
}

/** Ray against every other player's rewound capsule. Returns the nearest hit before `maxT`. */
export function traceTargets(
  w: World,
  shooter: Player,
  { dx, dz, maxT }: { dx: number; dz: number; maxT: number },
  time: number,
): { id: number; t: number } | null {
  let best: { id: number; t: number } | null = null
  const r2 = PLAYER_RADIUS * PLAYER_RADIUS
  for (const target of w.players) {
    if (!target || target.gone || target.id === shooter.id) {
      continue
    }
    const pose = poseAt(w, target.id, time)
    // Dead, rolling through i-frames, or in a showdown ring: bullets pass through.
    if (
      !pose ||
      (pose.flags & HIST_ALIVE) === 0 ||
      (pose.flags & (HIST_IFRAMES | HIST_SHOWDOWN)) !== 0
    ) {
      continue
    }
    const ox = pose.x - shooter.x
    const oz = pose.z - shooter.z
    const along = ox * dx + oz * dz
    if (along <= 0) {
      continue
    }
    const perp2 = ox * ox + oz * oz - along * along
    if (perp2 > r2) {
      continue
    }
    const t = along - Math.sqrt(r2 - perp2)
    if (t < (best?.t ?? maxT)) {
      best = { id: target.id, t: Math.max(0, t) }
    }
  }
  return best
}

export const damageAt = (range: number, deadEye: boolean): number =>
  (deadEye ? REVOLVER_DAMAGE * DEAD_EYE_MULTIPLIER : REVOLVER_DAMAGE) *
  (range > FALLOFF_RANGE ? FALLOFF_FACTOR : 1)

/**
 * Land a hit on `targetId` as seen at rewound `time`: spawn-protected targets absorb it, and the
 * shooter's hit stats (and the aim-snap heuristic) update. Returns true if it killed.
 */
export function strike(
  w: World,
  p: Player,
  { targetId, time, damage, deadEye, aim }: Strike,
): boolean {
  const target = w.players[targetId]
  const pose = poseAt(w, targetId, time)
  if (!(target && pose && (pose.flags & HIST_PROTECTED) === 0 && target.alive)) {
    return false
  }
  p.stats.hits++
  const aimDelta = Math.abs(((aim - p.prevAim + 98_304) % 65_536) - 32_768)
  if (aimDelta > AIM_SNAP_UNITS) {
    p.stats.snapHits++
  }
  return applyDamage(w, target, p, { amount: damage, deadEye })
}

/** Fire one revolver round. Assumes `canFire` passed. */
export function fire(w: World, p: Player, aim: number, viewTime: number): ShotResult {
  const deadEye = deadEyeReady(w, p)
  p.ammo--
  // Keep up to one tick of leftover credit so fanning the trigger averages 280 ms, not 300.
  p.fireCooldownMs = (p.fireCooldownMs > -TICK_MS ? p.fireCooldownMs : 0) + REVOLVER_FIRE_MS
  p.lastFireTick = w.tick
  p.deadEyeStart = -1
  // Firing ends spawn protection.
  p.protectUntil = Math.min(p.protectUntil, w.tick)
  p.stats.shots++
  let spreadDeg = p.moving ? SPREAD_MOVING_DEG : SPREAD_STANDING_DEG
  if (deadEye) {
    spreadDeg = 0
  }
  const angle = aimRadians(aim) + hashSigned(w.seed, p.id, w.tick, p.stats.shots) * spreadDeg * DEG
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  const wall = rayGrid(w.grid, { ox: p.x, oz: p.z, dx, dz, maxDist: MAX_RANGE }, BLOCK_SHOT)
  const time = rewindTime(w, viewTime)
  const hit = traceTargets(w, p, { dx, dz, maxT: wall }, time)
  const range = hit ? hit.t : wall
  let flags = deadEye ? SHOT_DEAD_EYE : 0
  let killed = false
  if (hit) {
    flags |= SHOT_HIT
    killed = strike(w, p, {
      targetId: hit.id,
      time,
      damage: damageAt(hit.t, deadEye),
      deadEye,
      aim,
    })
  } else if (wall < MAX_RANGE) {
    flags |= SHOT_WALL
  }
  w.events.push({
    type: 'shot',
    shooter: p.id,
    aim: radiansToAim(angle),
    range: Math.min(255, Math.round(range / SHOT_RANGE_UNIT)),
    target: hit ? hit.id : NONE,
    flags,
    x: p.x,
    z: p.z,
  })
  return { target: hit ? hit.id : NONE, range, deadEye, killed }
}

/** Fire-rate, ammo and state checks: the server-side limits a client can't bypass. */
export function canFire(p: Player, buttons: number, aliveAtTickStart: boolean): boolean {
  return (
    pressed(buttons, p.lastButtons, BTN_FIRE) &&
    aliveAtTickStart &&
    p.showdown < 0 &&
    p.lingerUntil < 0 &&
    p.rollTicks === 0 &&
    p.fireCooldownMs <= 0 &&
    (p.weapon === WEAPON_REVOLVER ? p.reloadTicks === 0 && p.ammo > 0 : p.weaponRounds > 0)
  )
}
