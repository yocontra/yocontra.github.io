// biome-ignore-all lint/complexity/useMaxParams: per-frame camera update takes positional numbers
/**
 * The Frontier camera: perspective, looking north (screen up = −z, so the minimap and the screen
 * agree), following the player with a little look-ahead.
 *
 * Lead ruling (replaces spec §3.1's "30° FOV, ~26 m, 18 m radius in every orientation", which
 * can't all hold: 18 m each way at 30° needs ~69 m in landscape and ~147 m in portrait, where a
 * character is ~1/40 of the screen):
 * - FOV 40°, pitch 58°.
 * - Visible ground: 18 m each way along the screen's LONG axis, at least 12 m along the SHORT axis
 *   (portrait: 18 m north/south, ≥12 m east/west; landscape the other way round).
 * - Readability clamp: the camera never pulls back so far that a character (2.25 m on screen) is
 *   under 6% of the short axis in landscape, 9% in portrait, and that wins over the radii.
 *   Landscape (16:10 to 19.5:9) fits at 35.5 m but clamps to 27.5 m (about ±16 m wide, ±9.5 m
 *   deep). Portrait fits at 72 m but clamps to about 40 m (±12 m tall, about ±7 m wide): at 59 m
 *   a phone held upright was mostly sand around a speck of a gunslinger. The look-ahead runs
 *   further along the long axis, so you see where you aim.
 * - Enemies within 18 m but off screen get edge arrows (`client/arrows.ts`).
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

export const VISIBLE_RADIUS = 18
export const PITCH_DEG = 58
const FOV = 40
const BASE_DIST = 22
/** Ground metres guaranteed each way along the screen's short axis. */
export const SHORT_RADIUS = 12
/** A character must stand at least this fraction of the short axis tall (landscape, portrait). */
const MIN_CHAR_FRACTION = 0.06
const MIN_CHAR_FRACTION_PORTRAIT = 0.09
/** On-screen character height (1.8 m × the crowd's read scale). */
const CHAR_H = 2.25
const PITCH = MathUtils.degToRad(PITCH_DEG)
/** Height of the point the camera frames above the ground (a man's chest). */
const AIM_Y = 1

const tmp = new Vector3()
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export class TopDownCamera {
  readonly camera = new PerspectiveCamera(FOV, 1, 1, 160)
  readonly target = new Vector3(72, 0, 64)
  distance = BASE_DIST
  private readonly shake = { t: 0, amp: 0 }
  /** Look-ahead toward the aim (m), eased. */
  private readonly lead = new Vector3()
  /** Look-ahead reach along screen x and z (m): longer along the long axis. */
  private readonly reach = { x: 2.2, z: 2.2 }

  resize(aspect: number): void {
    this.camera.aspect = aspect
    this.reach.x = aspect >= 1 ? 3.2 : 1.6
    this.reach.z = aspect >= 1 ? 1.6 : 3.4
    this.distance = Math.max(BASE_DIST, Math.min(fitDistance(aspect), readableDistance(aspect)))
    this.camera.near = Math.max(1, this.distance - 30)
    this.camera.far = this.distance + 90
    this.camera.updateProjectionMatrix()
  }

  kick(amp: number): void {
    if (REDUCED_MOTION) {
      return
    }
    this.shake.amp = Math.max(this.shake.amp, amp)
  }

  /** Follow the player with a little look-ahead toward where they aim. */
  update(px: number, pz: number, aimX: number, aimZ: number, dt: number): void {
    const k = 1 - Math.exp(-dt * 3)
    this.lead.x += (aimX * this.reach.x - this.lead.x) * k
    this.lead.z += (aimZ * this.reach.z - this.lead.z) * k
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

  /** Snap without easing (spawn, respawn), already leading toward the aim (unit x, z). */
  snap(px: number, pz: number, aimX = 0, aimZ = 0): void {
    this.lead.set(aimX * this.reach.x, 0, aimZ * this.reach.z)
    this.target.set(px + this.lead.x, 0, pz + this.lead.z)
    this.update(px, pz, aimX, aimZ, 0)
  }
}

const fitCam = new PerspectiveCamera(FOV, 1, 0.5, 400)

function place(d: number, aspect: number): PerspectiveCamera {
  fitCam.aspect = aspect
  fitCam.updateProjectionMatrix()
  fitCam.position.set(0, AIM_Y + Math.sin(PITCH) * d, Math.cos(PITCH) * d)
  fitCam.lookAt(0, AIM_Y, 0)
  fitCam.updateMatrixWorld(true)
  return fitCam
}

function bisect(ok: (d: number) => boolean, wantSmallest: boolean): number {
  let lo = 8
  let hi = 300
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid) === wantSmallest) {
      hi = mid
    } else {
      lo = mid
    }
  }
  return wantSmallest ? hi : lo
}

/**
 * Smallest distance at which the ground shows `VISIBLE_RADIUS` m each way along the long screen
 * axis and `SHORT_RADIUS` m along the short one.
 */
export function fitDistance(aspect: number): number {
  const landscape = aspect >= 1
  const rx = landscape ? VISIBLE_RADIUS : SHORT_RADIUS
  const rz = landscape ? SHORT_RADIUS : VISIBLE_RADIUS
  const pts = [
    new Vector3(rx, 0, 0),
    new Vector3(-rx, 0, 0),
    new Vector3(0, 0, rz),
    new Vector3(0, 0, -rz),
  ]
  return bisect((d) => {
    const cam = place(d, aspect)
    return pts.every((p) => {
      tmp.copy(p).project(cam)
      return Math.abs(tmp.x) <= 0.98 && Math.abs(tmp.y) <= 0.98 && tmp.z < 1
    })
  }, true)
}

/** Largest distance at which a character is still `MIN_CHAR_FRACTION` of the short axis tall. */
export function readableDistance(aspect: number): number {
  // In NDC the screen is 2 tall; the short axis is the height in landscape, the width in portrait.
  const fraction = aspect >= 1 ? MIN_CHAR_FRACTION : MIN_CHAR_FRACTION_PORTRAIT
  const need = 2 * fraction * Math.min(1, aspect)
  return bisect((d) => {
    const cam = place(d, aspect)
    const foot = tmp.set(0, 0, 0).project(cam).y
    const head = tmp.set(0, CHAR_H, 0).project(cam).y
    return head - foot >= need
  }, false)
}
