// biome-ignore-all lint/complexity/useMaxParams: hot-path ray helpers take positional numbers
/**
 * Shooter-view aiming: the crosshair's camera ray, resolved to the point it rests on, turned into
 * the yaw the sim fires along.
 *
 * The sim's hitscan is 2D: a ray from the shooter's centre along the aim yaw, against every
 * rider's capsule (an upright cylinder of any height) and the wall grid (buildings full height,
 * low cover stops bullets but not sight). So pitch is cosmetic and only the yaw matters, but over
 * the shoulder the camera sits 0.6 m to the side and 2.7 m back: the camera's own yaw would miss
 * by that parallax at close range. Instead we find what the crosshair is on (a rider, a wall, low
 * cover, the ground, or far sky) and send the yaw from the player's centre to that point, so the
 * server's ray passes through exactly what you aimed at. u16 aim is 0.0055° per step: plenty.
 *
 * Touch only: light aim assist. Friction slows the look while the crosshair is on or near a
 * rider; on the shot, magnetism nudges the view up to 2.5° onto the nearest rider within 25 m.
 */
import { Vector3 } from 'three'
import { EF_ALIVE, EF_PROTECTED, EF_SHOWDOWN } from '../../contract/town.ts'
import { BODY_HEIGHT, PLAYER_RADIUS } from '../sim/constants.ts'
import type { Grid } from '../sim/layout.ts'
import { rayWorld } from '../sim/surfaces.ts'
import type { RemoteView } from './interp.ts'

const BODY_R = PLAYER_RADIUS
const FAR = 160
/** Closer than this (planar, from the player) the yaw to the point is unstable: use the view's. */
const MIN_PLANAR = 1.2
const ASSIST_CONE = (2.5 * Math.PI) / 180
const FRICTION_CONE = (5 * Math.PI) / 180
const ASSIST_RANGE = 25

export interface AimResult {
  /** Yaw for the sim, radians (aim convention: 0 = +x, toward +z). */
  yaw: number
  /** The world point under the crosshair. */
  point: Vector3
  /** Rider under the crosshair (alive, hittable), or −1. */
  target: number
  /** Distance from the player to the point (planar, m). */
  range: number
}

const dir = new Vector3()

/**
 * The crosshair ray from `origin` along (yaw, pitch), resolved against riders, the walls, low
 * cover and the ground; then the sim yaw from the player at (px, pz).
 */
export function resolveAim(
  origin: Vector3,
  yaw: number,
  pitch: number,
  px: number,
  pz: number,
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
  const behind = Math.max(0, ((px - origin.x) * pdx + (pz - origin.z) * pdz) / planar)
  let target = -1
  for (const r of remotes) {
    if (!hittable(r)) {
      continue
    }
    const hit = rayCylinder(origin, pdx, pdz, planar, dir.y, r.x, r.y, r.z)
    if (hit !== null && hit < t && hit > behind) {
      t = hit
      target = r.id
    }
  }
  out.point.copy(origin).addScaledVector(dir, t)
  out.target = target
  const dx = out.point.x - px
  const dz = out.point.z - pz
  out.range = Math.hypot(dx, dz)
  // a point at your feet or behind you (looking steeply down) has no stable bearing: use the view's
  out.yaw = dx * pdx + dz * pdz > MIN_PLANAR ? Math.atan2(dz, dx) : yaw
  return out
}

function hittable(r: RemoteView): boolean {
  return (r.flags & EF_ALIVE) !== 0 && (r.flags & (EF_SHOWDOWN | EF_PROTECTED)) === 0
}

/** Ray (origin + t·dir) against an upright capsule at (cx, cy, cz). */
function rayCylinder(
  o: Vector3,
  pdx: number,
  pdz: number,
  planar: number,
  dy: number,
  cx: number,
  cy: number,
  cz: number,
): number | null {
  const ox = cx - o.x
  const oz = cz - o.z
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
  return y >= cy - 0.05 && y <= cy + BODY_HEIGHT + 0.05 ? t : null
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
