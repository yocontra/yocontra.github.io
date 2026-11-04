// biome-ignore-all lint/complexity/useMaxParams: the per-frame camera update takes positional numbers
/**
 * The Frontier's shooter camera: over the right (or left) shoulder by default, or first person at
 * eye height. It drives the same PerspectiveCamera the renderer was built with (the top-down
 * camera's), so switching views never rebuilds the post chain.
 *
 * - Yaw and pitch come straight from the mouse / touch look (no lag on aim). Yaw uses the sim's
 *   aim convention: 0 = +x, increasing toward +z; forward is (cos yaw, sin yaw).
 * - The pivot sits on the render pose (`NetClient.localRenderPose`), which is already smoothed:
 *   no second filter on top, so the camera never trails your rider. A vault or a hop lifts it
 *   along the same arc the body takes.
 * - Over the shoulder: 2.7 m back, 0.6 m to the side, 0.3 m up from a 1.5 m pivot; aiming down the
 *   sights pulls in to 1.5 m and 0.45 m and narrows the field of view. The shoulder swap eases over.
 * - Walls: a ray on the town's sight grid from the pivot to the wanted spot; the camera snaps in in
 *   front of a wall at once and eases back out (never a frame inside a building).
 * - First person: eye at 1.62 m with a walk bob; the gun is the view model (`viewmodel.ts`).
 * - Recoil kicks the view up and settles back; hits and blasts shake it (off under reduced motion).
 * - Crouch lowers the eye (and the shoulder pivot) 0.45 m, a slide 0.6 m, eased.
 * - Dead: the lens rises off your shoulder and drifts round your body, looking down at it, until
 *   you ride back in (the respawn snaps it back).
 */
import { MathUtils, type PerspectiveCamera, Vector3 } from 'three'
import { BLOCK_SIGHT, type Grid, rayGrid } from '../sim/layout.ts'

export const PIVOT_Y = 1.5
export const EYE_Y = 1.62
const BACK = 2.7
const BACK_ADS = 1.35
const SIDE = 0.8
const SIDE_ADS = 0.72
const UP = 0.3
const UP_ADS = 0.24
/** Sprinting widens the field of view by this fraction. */
const SPRINT_FOV = 0.08
/** The kill cam: this long from behind your killer before the lens drifts round your body (s). */
const KILL_CAM_S = 2.5
/** Keep the lens this far off a wall it was pulled in front of (m). */
const WALL_PAD = 0.4
/** The lens is a ball this wide (m): its edges are tested too, so a wall can't fill the frame. */
const LENS_R = 0.25
/** Never below this height (the camera tucks under when you look straight up). */
const MIN_Y = 0.35
const PITCH_MIN = MathUtils.degToRad(-70)
const PITCH_MAX = MathUtils.degToRad(65)
const PITCH_MIN_FIRST = MathUtils.degToRad(-85)
const PITCH_MAX_FIRST = MathUtils.degToRad(85)
/** ADS field of view as a fraction of the base. */
const ADS_ZOOM_THIRD = 0.72
const ADS_ZOOM_FIRST = 0.78

const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const fwd = new Vector3()
const right = new Vector3()
const want = new Vector3()
const look = new Vector3()

export interface ShooterFrame {
  /** Player render position. */
  x: number
  z: number
  /** Planar speed (m/s), for the first-person bob. */
  speed: number
  /** Height of a vault or hop arc right now (m), 0 on the ground. */
  lift: number
  first: boolean
  ads: boolean
  /** Base vertical FOV for this mode, degrees. */
  fov: number
  /** −1 left shoulder, 1 right. */
  shoulder: number
  /** Far plane (m) and the town's sight grid for wall checks. */
  far: number
  grid: Grid
  dt: number
  /** How far the stance lowers the eye (m): 0 standing, 0.45 crouched, 0.6 sliding. */
  duck: number
  /** Sprinting: the lens widens a touch (CoD's sprint FOV). */
  sprinting?: boolean
  /** Where your body lies while you're dead (the death camera), or null. */
  dead: { x: number; z: number } | null
  /** Who killed you, where he stands (the kill cam's first 2.5 s look from behind him). */
  killer?: { x: number; z: number } | null
}

export class ShooterCamera {
  readonly camera: PerspectiveCamera
  yaw = 0
  pitch = -0.08
  private readonly pivot = new Vector3(72, PIVOT_Y, 64)
  private side = SIDE
  private back = BACK
  private up = UP
  /** The camera's distance behind the pivot after the wall check (eases out, snaps in). */
  private reach = BACK
  /** ADS blend, 0..1. */
  ads = 0
  private fov = 72
  /** Recoil: extra pitch (rad) that settles back. */
  private recoil = 0
  /** First person: the view model's own kick (rad), added to the lens's pitch. */
  vmKick = 0
  private readonly shake = { t: 0, amp: 0 }
  private bobPhase = 0
  private bobAmp = 0
  /** How close the lens is to the pivot (0 far … 1 inside the head): hide the body when high. */
  closeness = 0
  /** Your body's fade (1 solid … 0 gone) as the lens comes within 0.7 m of it. */
  bodyFade = 1
  /** The shoulder actually in use (−1 / 1): swaps itself when the chosen side is walled in. */
  private side0 = 1
  private duck = 0
  /** The sprint's FOV widening (0..1, eased) and the landing's dip (a spring, m). */
  private sprintK = 0
  private dip = 0
  private dipV = 0
  private lastLift = 0
  /** Seconds into the death camera (0 alive). */
  private deadT = 0

  constructor(camera: PerspectiveCamera) {
    this.camera = camera
  }

  /** Face a direction at once (spawn, respawn, a view switch). */
  snap(x: number, z: number, yaw: number): void {
    this.pivot.set(x, PIVOT_Y, z)
    this.yaw = yaw
    this.pitch = -0.08
    this.recoil = 0
    this.reach = BACK
  }

  /** Mouse / touch look, radians. */
  turn(dYaw: number, dPitch: number, first: boolean): void {
    this.yaw = wrap(this.yaw + dYaw)
    this.pitch = MathUtils.clamp(
      this.pitch + dPitch,
      first ? PITCH_MIN_FIRST : PITCH_MIN,
      first ? PITCH_MAX_FIRST : PITCH_MAX,
    )
  }

  /** A shot's kick: the view jumps up and settles (cosmetic: the aim stays where you put it). */
  kickRecoil(rad: number): void {
    if (!REDUCED_MOTION) {
      this.recoil = Math.min(0.12, this.recoil + rad)
    }
  }

  /** A hit or a blast nearby shakes the view. */
  kick(amp: number): void {
    if (!REDUCED_MOTION) {
      this.shake.amp = Math.max(this.shake.amp, amp * 0.35)
    }
  }

  /** The view's pitch including the recoil kick (what the lens shows). */
  get viewPitch(): number {
    return this.pitch + this.recoil
  }

  update(f: ShooterFrame): void {
    const dt = f.dt
    const cam = this.camera
    const ease = (rate: number) => 1 - Math.exp(-dt * rate)
    this.ads += ((f.ads ? 1 : 0) - this.ads) * ease(14)
    this.duck += (f.duck - this.duck) * ease(12)
    this.sprintK += ((f.sprinting ? 1 : 0) - this.sprintK) * ease(f.sprinting ? 6 : 10)
    // the landing: the view dips and springs back
    if (this.lastLift > 0.05 && f.lift <= 0.02 && !REDUCED_MOTION) {
      this.dipV -= 1.6
    }
    this.lastLift = f.lift
    // a stiff spring: stepped at most 1/30 s at a time so a hitch can't throw it
    const sd = Math.min(dt, 1 / 30)
    this.dipV += (-140 * this.dip - 18 * this.dipV) * sd
    this.dip += this.dipV * sd
    if (f.dead) {
      this.deathCam(f, dt)
      return
    }
    this.deadT = 0
    // the pivot rides the (already smoothed) render pose, lifted through a vault or a hop
    this.pivot.set(f.x, PIVOT_Y + f.lift - this.duck + this.dip, f.z)
    this.recoil *= Math.exp(-dt * 9)
    this.shake.t += dt
    this.shake.amp *= Math.exp(-dt * 10)
    const pitch = this.pitch + this.recoil + (f.first ? this.vmKick : 0)
    const sx = Math.sin(this.shake.t * 63) * this.shake.amp * 0.04
    const sy = Math.cos(this.shake.t * 51) * this.shake.amp * 0.04
    const cy = Math.cos(this.yaw)
    const sy0 = Math.sin(this.yaw)
    fwd.set(cy * Math.cos(pitch), Math.sin(pitch), sy0 * Math.cos(pitch))
    right.set(-sy0, 0, cy)
    if (f.first) {
      this.firstPerson(f, dt)
    } else {
      this.thirdPerson(f, ease)
    }
    look.copy(cam.position).add(fwd)
    look.x += right.x * sx
    look.y += sy
    look.z += right.z * sx
    cam.up.set(0, 1, 0)
    cam.lookAt(look)
    // FOV and planes: only touch the projection when something changed
    const zoom = f.first ? ADS_ZOOM_FIRST : ADS_ZOOM_THIRD
    const fov =
      portraitFov(f.fov, cam.aspect) * (1 - (1 - zoom) * this.ads) * (1 + SPRINT_FOV * this.sprintK)
    const near = f.first ? 0.05 : 0.1
    if (Math.abs(fov - this.fov) > 0.01 || cam.near !== near || cam.far !== f.far) {
      this.fov = fov
      cam.fov = fov
      cam.near = near
      cam.far = f.far
      cam.updateProjectionMatrix()
    } else if (cam.fov !== this.fov) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
  }

  /** Up off the shoulder and round the body, looking down at it. */
  private deathCam(f: ShooterFrame, dt: number): void {
    const body = f.dead
    if (!body) {
      return
    }
    this.deadT += dt
    const cam = this.camera
    const k = f.killer
    if (k && this.deadT < KILL_CAM_S) {
      // the kill cam: over his shoulder, looking at you where you fell
      const dx = k.x - body.x
      const dz = k.z - body.z
      const d = Math.hypot(dx, dz) || 1
      want.set(
        k.x + (dx / d) * 1.6 + (-dz / d) * 0.6,
        EYE_Y + 0.5,
        k.z + (dz / d) * 1.6 + (dx / d) * 0.6,
      )
      const freeK = clearance(f.grid, k.x, k.z, want.x, want.z)
      want.x = k.x + (want.x - k.x) * freeK
      want.z = k.z + (want.z - k.z) * freeK
      cam.position.lerp(want, this.deadT < 0.05 ? 1 : 1 - Math.exp(-dt * 6))
      cam.up.set(0, 1, 0)
      cam.lookAt(body.x, 0.6, body.z)
      this.closeness = 0
      return
    }
    const t = Math.min(1, Math.max(0, this.deadT - (k ? KILL_CAM_S : 0)) / 1.2)
    const e = t * t * (3 - 2 * t)
    const orbit = this.yaw + Math.PI + this.deadT * 0.25
    const dist = 1.5 + 2.5 * e
    want.set(body.x + Math.cos(orbit) * dist, EYE_Y + 2.2 * e, body.z + Math.sin(orbit) * dist)
    // keep out of walls: pull in toward the body
    const free = clearance(f.grid, body.x, body.z, want.x, want.z)
    want.x = body.x + (want.x - body.x) * free
    want.z = body.z + (want.z - body.z) * free
    cam.position.lerp(want, 1 - Math.exp(-dt * 4))
    cam.up.set(0, 1, 0)
    cam.lookAt(body.x, 0.4, body.z)
    this.closeness = 0
  }

  private firstPerson(f: ShooterFrame, dt: number): void {
    const moving = Math.min(1, f.speed / 5.5)
    this.bobAmp += (moving * (1 - this.ads * 0.7) - this.bobAmp) * (1 - Math.exp(-dt * 8))
    this.bobPhase += dt * (6 + f.speed * 1.4)
    const bob = REDUCED_MOTION ? 0 : this.bobAmp
    const by = Math.abs(Math.sin(this.bobPhase)) * 0.045 * bob
    const bx = Math.cos(this.bobPhase) * 0.025 * bob
    this.camera.position.set(
      this.pivot.x + Math.cos(this.yaw) * 0.12 + right.x * bx,
      this.pivot.y - PIVOT_Y + EYE_Y + by - 0.02 * bob,
      this.pivot.z + Math.sin(this.yaw) * 0.12 + right.z * bx,
    )
    this.closeness = 1
  }

  private thirdPerson(f: ShooterFrame, ease: (r: number) => number): void {
    const a = this.ads
    // a phone held upright is narrow: the shoulder comes in and the lens backs off a little
    const aspect = this.camera.aspect
    const narrow = MathUtils.clamp(aspect / 1.3, 0.45, 1)
    // a wall hard on the chosen shoulder: swing to the other one while it lasts
    const chosen = f.shoulder
    const reachSide = (s: number) =>
      clearance(
        f.grid,
        this.pivot.x,
        this.pivot.z,
        this.pivot.x + right.x * s,
        this.pivot.z + right.z * s,
      )
    if (reachSide(chosen * SIDE) < 0.6 && reachSide(-chosen * SIDE) > 0.95) {
      this.side0 = -chosen
    } else if (reachSide(chosen * SIDE) > 0.9) {
      this.side0 = chosen
    }
    const sideTo = this.side0 * MathUtils.lerp(SIDE, SIDE_ADS, a) * narrow
    this.side += (sideTo - this.side) * ease(10)
    this.back = MathUtils.lerp(BACK, BACK_ADS, a) * (aspect < 1 ? 1.15 : 1)
    this.up = MathUtils.lerp(UP, UP_ADS, a)
    // the shoulder point, then back along the view from there
    const px = this.pivot.x + right.x * this.side
    const pz = this.pivot.z + right.z * this.side
    const py = this.pivot.y + this.up
    want.set(px - fwd.x * this.back, py - fwd.y * this.back, pz - fwd.z * this.back)
    // walls: from the body's centre to the shoulder, then on to the lens
    const shoulderFree = clearance(f.grid, this.pivot.x, this.pivot.z, px, pz)
    const sideK = Math.min(shoulderFree, 1)
    const sx = this.pivot.x + (px - this.pivot.x) * sideK
    const sz = this.pivot.z + (pz - this.pivot.z) * sideK
    // the lens is a ball: its centre and both edges must be clear
    const ex = -fwd.z
    const ez = fwd.x
    const flat = Math.hypot(ex, ez) || 1
    const lx = (ex / flat) * LENS_R
    const lz = (ez / flat) * LENS_R
    const free = Math.min(
      clearance(f.grid, sx, sz, want.x, want.z),
      clearance(f.grid, sx + lx, sz + lz, want.x + lx, want.z + lz),
      clearance(f.grid, sx - lx, sz - lz, want.x - lx, want.z - lz),
    )
    const target = this.back * free
    // in at once, out gently
    this.reach = target < this.reach ? target : this.reach + (target - this.reach) * ease(5)
    const k = this.back > 0 ? this.reach / this.back : 1
    this.camera.position.set(
      sx - fwd.x * this.back * k,
      Math.max(MIN_Y, py - fwd.y * this.back * k),
      sz - fwd.z * this.back * k,
    )
    // the closer the lens, the more the body would fill it
    this.closeness = MathUtils.clamp(1 - (this.reach - 0.35) / 0.5, 0, 1)
    // within 0.7 m your body thins out (dithered), so it never fills the frame or hides the aim
    const near = Math.hypot(
      this.camera.position.x - this.pivot.x,
      this.camera.position.z - this.pivot.z,
    )
    this.bodyFade = MathUtils.clamp((near - 0.35) / 0.35, 0.15, 1)
  }
}

/** Portrait never narrows the view below this horizontal field (degrees). */
const MIN_HFOV = 54
const MAX_VFOV = 95

/** The vertical FOV to use: the setting, widened in portrait to keep `MIN_HFOV` across. */
export function portraitFov(fov: number, aspect: number): number {
  const need = (2 * Math.atan(Math.tan((MIN_HFOV * Math.PI) / 360) / aspect) * 180) / Math.PI
  return Math.min(MAX_VFOV, Math.max(fov, need))
}

/** Fraction (0..1) of the way from a to b that's clear of sight-blocking walls, padded. */
function clearance(grid: Grid, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const d = Math.hypot(dx, dz)
  if (d < 1e-4) {
    return 1
  }
  const hit = rayGrid(
    grid,
    { ox: ax, oz: az, dx: dx / d, dz: dz / d, maxDist: d + WALL_PAD },
    BLOCK_SIGHT,
  )
  if (hit >= d + WALL_PAD) {
    return 1
  }
  return Math.max(0, (hit - WALL_PAD) / d)
}

export function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}
