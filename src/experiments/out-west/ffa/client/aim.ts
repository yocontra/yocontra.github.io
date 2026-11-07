// biome-ignore-all lint/complexity/useMaxParams: hot-path ray helpers take positional numbers
/**
 * Resolve the camera's crosshair ray against the 3D town and riders, then aim from the shooter's
 * actual eye to that point. Both angles account for the shoulder camera's displacement.
 * Touch assist only nudges the camera; it never changes the authoritative hit geometry.
 */
import { Vector3 } from 'three'
import { EF_ALIVE, EF_PROTECTED, EF_SHOWDOWN, STANCE_CROUCH } from '../../contract/town.ts'
import { BODY_HEIGHT, CROUCH_HEIGHT, PLAYER_RADIUS } from '../sim/constants.ts'
import type { Grid } from '../sim/layout.ts'
import { rayWorld } from '../sim/surfaces.ts'
import type { RemoteView } from './interp.ts'

const BODY_R = PLAYER_RADIUS
/** Crosshair reach, metres: past the longest weapon range, short of a full-map ray walk. */
const FAR = 60
const ASSIST_CONE = (2.5 * Math.PI) / 180
const FRICTION_CONE = (5 * Math.PI) / 180
const ASSIST_RANGE = 25

export interface AimResult {
  /** Yaw for the sim, radians (aim convention: 0 = +x, toward +z). */
  yaw: number
  /** Pitch from the shooter's eye to the target, radians (up positive). */
  pitch: number
  /** The world point under the crosshair. */
  point: Vector3
  /** Rider under the crosshair (alive, hittable), or −1. */
  target: number
  /** Distance from the shooter eye to the point (m). */
  range: number
}

const dir = new Vector3()

/**
 * The crosshair ray from `origin` along (yaw, pitch), resolved against riders, the walls, low
 * cover and the ground; then the sim yaw and pitch from the shooter's eye.
 */
export function resolveAim(
  origin: Vector3,
  yaw: number,
  pitch: number,
  shooter: { x: number; y: number; z: number },
  grid: Grid,
  remotes: readonly RemoteView[],
  out: AimResult,
): AimResult {
  const cp = Math.cos(pitch)
  dir.set(Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp)
  const planar = Math.max(1e-5, cp)
  const pdx = Math.cos(yaw)
  const pdz = Math.sin(yaw)
  // The world first: walls, crates, porch roofs, floors and pitched roofs in 3D.
  const world = rayWorld(grid, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, FAR)
  let t = world?.dist ?? FAR
  // riders, but only past the player (someone between the lens and your back isn't the target)
  const behind = Math.max(0, ((shooter.x - origin.x) * pdx + (shooter.z - origin.z) * pdz) / planar)
  let target = -1
  for (const r of remotes) {
    if (!hittable(r)) {
      continue
    }
    const hit = rayCylinder(origin, pdx, pdz, planar, dir.y, r)
    if (hit !== null && hit < t && hit > behind) {
      t = hit
      target = r.id
    }
  }
  out.point.copy(origin).addScaledVector(dir, t)
  out.target = target
  const dx = out.point.x - shooter.x
  const dy = out.point.y - shooter.y
  const dz = out.point.z - shooter.z
  const horizontal = Math.hypot(dx, dz)
  out.range = Math.hypot(horizontal, dy)
  // Only a point behind the shooter's eye has an ambiguous bearing. Close targets in front still
  // need parallax correction; the old 1.2 m cutoff made point-blank aiming miss by a shoulder.
  const ahead = dx * pdx + dz * pdz
  out.yaw = ahead > 1e-4 && horizontal > 1e-4 ? Math.atan2(dz, dx) : yaw
  out.pitch = ahead > 1e-4 ? Math.atan2(dy, horizontal) : pitch
  return out
}

/** Predict a no-spread shot for immediate feedback, stopping at the world or a visible rider. */
export function predictShot(
  grid: Grid,
  origin: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
  range: number,
  remotes: readonly RemoteView[],
  out: Vector3,
): Vector3 {
  const cp = Math.cos(pitch)
  const dx = Math.cos(yaw)
  const dz = Math.sin(yaw)
  const dy = Math.sin(pitch)
  const wall = rayWorld(grid, origin.x, origin.y, origin.z, dx * cp, dy, dz * cp, range)
  let t = wall?.dist ?? range
  for (const r of remotes) {
    if (!hittable(r)) {
      continue
    }
    const hit = rayCylinder(origin, dx, dz, Math.max(1e-5, cp), dy, r)
    if (hit !== null && hit < t) {
      t = hit
    }
  }
  return out.set(origin.x + dx * cp * t, origin.y + dy * t, origin.z + dz * cp * t)
}

function hittable(r: RemoteView): boolean {
  return (r.flags & EF_ALIVE) !== 0 && (r.flags & (EF_SHOWDOWN | EF_PROTECTED)) === 0
}

/** Ray (origin + t·dir) against a rider's upright cylinder. */
function rayCylinder(
  o: { x: number; y: number; z: number },
  pdx: number,
  pdz: number,
  planar: number,
  dy: number,
  rider: RemoteView,
): number | null {
  const ox = rider.x - o.x
  const oz = rider.z - o.z
  const along = ox * pdx + oz * pdz
  if (along <= 0) {
    return null
  }
  const perp2 = ox * ox + oz * oz - along * along
  if (perp2 > BODY_R * BODY_R) {
    return null
  }
  const planarT = along - Math.sqrt(BODY_R * BODY_R - perp2)
  const t = Math.max(0, planarT) / planar
  const y = o.y + dy * t
  const height = rider.stance & STANCE_CROUCH ? CROUCH_HEIGHT : BODY_HEIGHT
  return y >= rider.y - 0.05 && y <= rider.y + height + 0.05 ? t : null
}

/** The nearest hittable rider's angular offset from the view (yaw, pitch), within `cone`. */
function nearestOffset(
  origin: Vector3,
  yaw: number,
  pitch: number,
  remotes: readonly RemoteView[],
  cone: number,
): { dYaw: number; dPitch: number } | null {
  let best: { dYaw: number; dPitch: number } | null = null
  let bestErr = cone
  for (const r of remotes) {
    if (!hittable(r)) {
      continue
    }
    const dx = r.x - origin.x
    const dz = r.z - origin.z
    const d = Math.hypot(dx, dz)
    if (d < 0.8 || d > ASSIST_RANGE) {
      continue
    }
    const ry = Math.atan2(dz, dx)
    const rp = Math.atan2(r.y + 1.2 - origin.y, d)
    const dYaw = Math.atan2(Math.sin(ry - yaw), Math.cos(ry - yaw))
    const dPitch = rp - pitch
    const err = Math.hypot(dYaw, dPitch)
    if (err < bestErr) {
      bestErr = err
      best = { dYaw, dPitch }
    }
  }
  return best
}

/** Touch look friction: 1 away from riders, down to 0.45 with the crosshair on one. */
export function assistFriction(
  origin: Vector3,
  yaw: number,
  pitch: number,
  remotes: readonly RemoteView[],
): number {
  const o = nearestOffset(origin, yaw, pitch, remotes, FRICTION_CONE)
  if (!o) {
    return 1
  }
  const err = Math.hypot(o.dYaw, o.dPitch) / FRICTION_CONE
  return 0.45 + 0.55 * err
}

/** Touch magnetism on the shot: the (yaw, pitch) nudge onto the nearest rider, or null. */
export function assistPull(
  origin: Vector3,
  yaw: number,
  pitch: number,
  remotes: readonly RemoteView[],
): { dYaw: number; dPitch: number } | null {
  const o = nearestOffset(origin, yaw, pitch, remotes, ASSIST_CONE)
  return o ? { dYaw: o.dYaw * 0.8, dPitch: o.dPitch * 0.5 } : null
}
