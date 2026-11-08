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
  BODY_HEIGHT,
  CROUCH_HEIGHT,
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
  TICK_MS,
} from './constants.ts'
import { applyDamage } from './death.ts'
import { aimRadians, airborne, climbing, radiansToAim, sliding, vaulting } from './move.ts'
import { hashSigned } from './rng.ts'
import { bloomAfterShot, settleBloom, spreadDeg } from './spread.ts'
import {
  HIST_ALIVE,
  HIST_CROUCHED,
  HIST_IFRAMES,
  HIST_PROTECTED,
  HIST_SHOWDOWN,
  poseAt,
  type World,
} from './state.ts'
import type { Player, ShotPoint } from './types.ts'
import { shatterGlass } from './windows.ts'

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
  p.bloom = settleBloom(p.bloom)
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

/** The shooter's eye height, metres above the feet. */
export const eyeHeight = (p: Pick<Player, 'crouched'>): number =>
  (p.crouched ? CROUCH_HEIGHT : BODY_HEIGHT) - 0.18

export interface ShotRay {
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
  maxT: number
}

/** A pitch in wire units (±127 = ±90°) as radians. */
export const pitchRadians = (pitch: number): number => (pitch / 127) * (Math.PI / 2)

/** A shot ray from the shooter's eye along `aim` and their pitch, with a yaw/pitch spread. */
export function shotRay(p: Player, aim: number, yawSpread = 0, pitchSpread = 0): ShotRay {
  const yaw = aimRadians(aim) + yawSpread
  const pitch = pitchRadians(p.pitch) + pitchSpread
  const cp = Math.cos(pitch)
  return {
    ox: p.x,
    oy: p.y + eyeHeight(p),
    oz: p.z,
    dx: Math.cos(yaw) * cp,
    dy: Math.sin(pitch),
    dz: Math.sin(yaw) * cp,
    maxT: MAX_RANGE,
  }
}

/** Ray against every other player's rewound capsule. Returns the nearest hit before `maxT`. */
export function traceTargets(
  w: World,
  shooter: Player,
  { ox, oy, oz, dx, dy, dz, maxT }: ShotRay,
  time: number,
): { id: number; t: number } | null {
  let best: { id: number; t: number } | null = null
  const r2 = PLAYER_RADIUS * PLAYER_RADIUS
  const planar = Math.hypot(dx, dz)
  if (planar < 1e-6) {
    return null
  }
  const pdx = dx / planar
  const pdz = dz / planar
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
    const cx = pose.x - ox
    const cz = pose.z - oz
    const along = cx * pdx + cz * pdz
    if (along <= 0) {
      continue
    }
    const perp2 = cx * cx + cz * cz - along * along
    if (perp2 > r2) {
      continue
    }
    const t = (along - Math.sqrt(r2 - perp2)) / planar
    if (t < 0 || t >= (best?.t ?? maxT)) {
      continue
    }
    const hitY = oy + dy * t
    const height = pose.flags & HIST_CROUCHED ? CROUCH_HEIGHT : BODY_HEIGHT
    if (hitY < pose.y - 0.05 || hitY > pose.y + height + 0.05) {
      continue
    }
    best = { id: target.id, t }
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
  const spread = deadEye ? 0 : spreadFor(p)
  p.bloom = bloomAfterShot(p.weapon, p.bloom)
  const jitter = hashSigned(w.seed, p.id, w.tick, p.stats.shots)
  const ray = shotRay(p, aim, jitter * spread * DEG, jitter * spread * DEG * 0.6)
  const wall = w.castWorld?.({ ...ray, maxT: MAX_RANGE }) ?? MAX_RANGE
  shatterGlass(w, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, wall)
  const time = rewindTime(w, viewTime)
  const hit = traceTargets(w, p, { ...ray, maxT: wall }, time)
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
  recordShot(w, p, ray, { range, target: hit ? hit.id : NONE, flags })

  return { target: hit ? hit.id : NONE, range, deadEye, killed }
}

/** Emit the exact ray the sim used; presentation must never reconstruct it from current poses. */
export function recordShot(
  w: World,
  p: Player,
  ray: ShotRay,
  trace: { range: number; target: number; flags: number; pellets?: ShotPoint[] },
): void {
  const { range, target, flags, pellets = [] } = trace
  const end = rayEnd(ray, range)
  w.events.push({
    type: 'shot',
    shooter: p.id,
    aim: radiansToAim(Math.atan2(ray.dz, ray.dx)),
    range: Math.min(255, Math.round(range / SHOT_RANGE_UNIT)),
    target,
    flags,
    x: p.x,
    z: p.z,
    y: Math.round(end.y * 10),
    origin: { x: ray.ox, y: ray.oy, z: ray.oz },
    end,
    pellets,
  })
}

export function rayEnd(ray: ShotRay, range: number): ShotPoint {
  return { x: ray.ox + ray.dx * range, y: ray.oy + ray.dy * range, z: ray.oz + ray.dz * range }
}

/** This player's spread right now (degrees; the shotgun's is its cone). */
export function spreadFor(p: Player): number {
  return spreadDeg({
    weapon: p.weapon,
    ads: p.ads,
    crouched: p.crouched,
    moving: p.moving,
    sliding: sliding(p),
    airborne: airborne(p),
    bloom: p.bloom,
  })
}

/**
 * This tick's trigger: a fresh `BTN_FIRE` press, or one held back while the gun came up out of a
 * sprint. A pull during the sprint-to-fire delay is queued (`fireQueued`) and fires when it ends.
 */
export function trigger(p: Player, buttons: number, aliveAtTickStart: boolean): boolean {
  const pull = pressed(buttons, p.lastButtons, BTN_FIRE) || p.fireQueued
  p.fireQueued = pull && aliveAtTickStart && p.sprintOut > 0
  return pull && !p.fireQueued
}

/** Fire-rate, ammo and state checks: the server-side limits a client can't bypass. */
export function canFire(p: Player, pulled: boolean, aliveAtTickStart: boolean): boolean {
  return (
    pulled &&
    aliveAtTickStart &&
    !p.sprinting &&
    p.sprintOut === 0 &&
    p.showdown < 0 &&
    p.lingerUntil < 0 &&
    p.rollTicks === 0 &&
    !vaulting(p) &&
    !climbing(p) &&
    p.fireCooldownMs <= 0 &&
    (p.weapon === WEAPON_REVOLVER ? p.reloadTicks === 0 && p.ammo > 0 : p.weaponRounds > 0)
  )
}
