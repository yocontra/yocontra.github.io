// biome-ignore-all lint/complexity/useMaxParams: a hot-path projection helper takes positional numbers
/**
 * World → screen for HUD markers, in every view. A point in front of the camera projects as usual;
 * a point behind it (third and first person look along the ground, so half the world is behind
 * you) is mirrored so its edge arrow points the right way round instead of flipping across the
 * screen. Off-screen points are clamped to an inset rectangle with the angle for a chevron.
 */
import { type CameraComponent, Vec3 } from 'playcanvas'

export interface ScreenPoint {
  /** Client pixels (clamped to the inset edge when off screen). */
  x: number
  y: number
  /** Inside the inset rectangle and in front of the camera. */
  on: boolean
  /** Direction from the screen centre toward the point, radians (screen space, y down). */
  angle: number
}

const v = new Vec3()
const world = new Vec3()
const direction = new Vec3()

export function toScreen(
  cam: CameraComponent,
  wx: number,
  wy: number,
  wz: number,
  inset: number,
  out: ScreenPoint,
): ScreenPoint {
  const canvas = cam.system.app.graphicsDevice.canvas
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  world.set(wx, wy, wz)
  direction.sub2(world, cam.entity.getPosition())
  const behind = direction.dot(cam.entity.forward) < cam.nearClip
  cam.worldToScreen(world, v)
  let ox = v.x - w / 2
  let oy = v.y - h / 2
  if (behind) {
    ox = -ox
    oy = -oy
    if (Math.abs(ox) + Math.abs(oy) < 0.001) {
      oy = h
    }
    const scale = Math.max(w / Math.max(Math.abs(ox), 0.001), h / Math.max(Math.abs(oy), 0.001))
    ox *= scale
    oy *= scale
  }
  const px = w / 2 + ox
  const py = h / 2 + oy
  const hx = w / 2 - inset
  const hy = h / 2 - inset
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
