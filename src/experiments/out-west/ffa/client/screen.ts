// biome-ignore-all lint/complexity/useMaxParams: a hot-path projection helper takes positional numbers
/**
 * World → screen for HUD markers, in every view. A point in front of the camera projects as usual;
 * a point behind it (third and first person look along the ground, so half the world is behind
 * you) is mirrored so its edge arrow points the right way round instead of flipping across the
 * screen. Off-screen points are clamped to an inset rectangle with the angle for a chevron.
 */
import { type PerspectiveCamera, Vector3 } from 'three'
import { viewport } from './viewport.ts'

export interface ScreenPoint {
  /** Client pixels (clamped to the inset edge when off screen). */
  x: number
  y: number
  /** Inside the inset rectangle and in front of the camera. */
  on: boolean
  /** Direction from the screen centre toward the point, radians (screen space, y down). */
  angle: number
}

const v = new Vector3()

export function toScreen(
  cam: PerspectiveCamera,
  wx: number,
  wy: number,
  wz: number,
  inset: number,
  out: ScreenPoint,
): ScreenPoint {
  const w = viewport.w
  const h = viewport.h
  v.set(wx, wy, wz).applyMatrix4(cam.matrixWorldInverse)
  const behind = v.z > -cam.near
  v.applyMatrix4(cam.projectionMatrix)
  let sx = v.x
  let sy = -v.y
  if (behind) {
    // behind the lens the projection inverts: flip it, and push it out to the edge
    sx = -sx
    sy = -sy
    if (Math.abs(sx) < 1e-3 && Math.abs(sy) < 1e-3) {
      sy = 1
    }
    const m = Math.max(Math.abs(sx), Math.abs(sy))
    sx = (sx / m) * 2
    sy = (sy / m) * 2
  }
  const px = w / 2 + (sx * w) / 2
  const py = h / 2 + (sy * h) / 2
  const hx = w / 2 - inset
  const hy = h / 2 - inset
  const ox = px - w / 2
  const oy = py - h / 2
  out.angle = Math.atan2(oy, ox)
  if (!behind && Math.abs(ox) <= hx && Math.abs(oy) <= hy) {
    out.x = px
    out.y = py
    out.on = true
    return out
  }
  const k = Math.min(hx / Math.max(1e-6, Math.abs(ox)), hy / Math.max(1e-6, Math.abs(oy)))
  out.x = w / 2 + ox * k
  out.y = h / 2 + oy * k
  out.on = false
  return out
}
