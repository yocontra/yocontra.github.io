// biome-ignore-all lint/complexity/useMaxParams: per-frame camera update takes positional numbers
/**
 * The Frontier camera (spec §3.1): perspective, 30° vertical FOV, pitched 58° down, about 26 m
 * from the player, looking north (screen up = −z, so the minimap and the screen agree). The
 * distance adapts to the aspect ratio so a ground circle of `VISIBLE_RADIUS` around the player is
 * always on screen, portrait included.
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

export const VISIBLE_RADIUS = 18
export const PITCH_DEG = 58
const FOV = 30
const BASE_DIST = 26
const PITCH = MathUtils.degToRad(PITCH_DEG)
/** Height of the point the camera frames above the ground (a man's chest). */
const AIM_Y = 1

const tmp = new Vector3()

export class TopDownCamera {
  readonly camera = new PerspectiveCamera(FOV, 1, 1, 160)
  readonly target = new Vector3(72, 0, 64)
  distance = BASE_DIST
  private readonly shake = { t: 0, amp: 0 }
  /** Look-ahead toward the aim (m), eased. */
  private readonly lead = new Vector3()

  resize(aspect: number): void {
    this.camera.aspect = aspect
    this.distance = Math.max(BASE_DIST, fitDistance(aspect))
    this.camera.near = Math.max(1, this.distance - 30)
    this.camera.far = this.distance + 90
    this.camera.updateProjectionMatrix()
  }

  kick(amp: number): void {
    this.shake.amp = Math.max(this.shake.amp, amp)
  }

  /** Follow the player with a little look-ahead toward where they aim. */
  update(px: number, pz: number, aimX: number, aimZ: number, dt: number): void {
    const k = 1 - Math.exp(-dt * 3)
    this.lead.x += (aimX * 2.2 - this.lead.x) * k
    this.lead.z += (aimZ * 2.2 - this.lead.z) * k
    const f = 1 - Math.exp(-dt * 12)
    this.target.x += (px + this.lead.x - this.target.x) * f
    this.target.z += (pz + this.lead.z - this.target.z) * f
    this.shake.t += dt
    this.shake.amp *= Math.exp(-dt * 9)
    const s = this.shake.amp
    const ox = Math.sin(this.shake.t * 61) * s
    const oz = Math.cos(this.shake.t * 47) * s
    const d = this.distance
    this.camera.position.set(
      this.target.x + ox,
      AIM_Y + Math.sin(PITCH) * d,
      this.target.z + Math.cos(PITCH) * d + oz,
    )
    this.camera.lookAt(tmp.set(this.target.x + ox, AIM_Y, this.target.z + oz))
  }

  /** Snap without easing (spawn, respawn). */
  snap(px: number, pz: number): void {
    this.target.set(px, 0, pz)
    this.lead.set(0, 0, 0)
    this.update(px, pz, 0, 0, 0)
  }
}

/**
 * Smallest camera distance at which ground points `VISIBLE_RADIUS` m north, south, east and west
 * of the target all project inside the view (bisection on the exact projection).
 */
export function fitDistance(aspect: number): number {
  const cam = new PerspectiveCamera(FOV, aspect, 0.5, 400)
  const r = VISIBLE_RADIUS
  const pts = [
    new Vector3(r, 0, 0),
    new Vector3(-r, 0, 0),
    new Vector3(0, 0, r),
    new Vector3(0, 0, -r),
  ]
  const fits = (d: number) => {
    cam.position.set(0, AIM_Y + Math.sin(PITCH) * d, Math.cos(PITCH) * d)
    cam.lookAt(0, AIM_Y, 0)
    cam.updateMatrixWorld(true)
    return pts.every((p) => {
      tmp.copy(p).project(cam)
      return Math.abs(tmp.x) <= 0.98 && Math.abs(tmp.y) <= 0.98 && tmp.z < 1
    })
  }
  let lo = 8
  let hi = 200
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) {
      hi = mid
    } else {
      lo = mid
    }
  }
  return hi
}
