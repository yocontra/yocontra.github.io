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
 * - Walls: a padded 3D sweep from the pivot to the wanted spot; the camera snaps in in
 *   front of a wall at once and eases back out (never a frame inside a building).
 * - First person: eye at 1.62 m with a walk bob; the gun is the view model (`viewmodel.ts`).
 * - Recoil kicks the view up and settles back; hits and blasts shake it (off under reduced motion).
 * - Crouch lowers the eye (and the shoulder pivot) 0.45 m, a slide 0.6 m, eased.
 * - Dead: the lens rises off your shoulder and drifts round your body, looking down at it, until
 *   you ride back in (the respawn snaps it back).
 */
import { MathUtils, type PerspectiveCamera, Vector3 } from 'three'
import type { Grid } from '../sim/layout.ts'
import { rayWorld } from '../sim/surfaces.ts'

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
const ORBIT_OFFSETS = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  Math.PI * 0.75,
  -Math.PI * 0.75,
  Math.PI,
]
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
  /** Absolute feet height, including the support beneath the player. */
  feetY: number
  /** True while supported, regardless of world elevation. */
  grounded: boolean
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
  dead: { x: number; z: number; y?: number } | null
  /** Centre of the dressed physical body, while a local corpse exists. */
  corpseFocus?: { x: number; y: number; z: number } | null
  /** Envelope of the actual physical body and fitted gear, around corpseFocus. */
  corpseRadius?: number
  /** Who killed you, where he stands (the kill cam's first 2.5 s look from behind him). */
  killer?: { x: number; z: number; y?: number } | null
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
  /** Recoil: extra pitch and yaw (rad) that settle back. */
  private recoil = 0
  private recoilYaw = 0
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
  private wasGrounded = true as boolean
  /** Seconds into the death camera (0 alive). */
  private deadT = 0
  private deadOrbit = 0

  constructor(camera: PerspectiveCamera) {
    this.camera = camera
  }

  /** Face a direction at once (spawn, respawn, a view switch). */
  snap(x: number, z: number, yaw: number, feetY = 0): void {
    this.pivot.set(x, PIVOT_Y + feetY, z)
    this.yaw = yaw
    this.pitch = -0.08
    this.recoil = 0
    this.recoilYaw = 0
    this.reach = BACK
    this.wasGrounded = true
    this.dip = 0
    this.dipV = 0
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

  /** A shot's kick: the view jumps up and a little sideways, then settles. */
  kickRecoil(rad: number, yaw = 0): void {
    if (!REDUCED_MOTION) {
      const k = 1 - this.ads * 0.45
      this.recoil = Math.min(0.12, this.recoil + rad * k)
      this.recoilYaw = Math.max(-0.04, Math.min(0.04, this.recoilYaw + yaw * k))
    }
  }

  /** A hit or a blast nearby shakes the view. */
  kick(amp: number): void {
    if (!REDUCED_MOTION) {
      this.shake.amp = Math.max(this.shake.amp, amp * 0.35)
    }
  }

  /** The view's pitch and yaw including recoil (what the lens shows, and what the shot follows). */
  get viewPitch(): number {
    return this.pitch + this.recoil
  }

  get viewYaw(): number {
    return wrap(this.yaw + this.recoilYaw)
  }

  update(f: ShooterFrame): void {
    const dt = f.dt
    const cam = this.camera
    const ease = (rate: number) => 1 - Math.exp(-dt * rate)
    this.ads += ((f.ads ? 1 : 0) - this.ads) * ease(14)
    this.duck += (f.duck - this.duck) * ease(12)
    this.sprintK += ((f.sprinting ? 1 : 0) - this.sprintK) * ease(f.sprinting ? 6 : 10)
    // the landing: the view dips and springs back
    if (!this.wasGrounded && f.grounded && !REDUCED_MOTION) {
      this.dipV -= 1.6
    }
    this.wasGrounded = f.grounded
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
    this.pivot.set(f.x, PIVOT_Y + f.feetY - this.duck + this.dip, f.z)
    this.recoil *= Math.exp(-dt * 9)
    this.recoilYaw *= Math.exp(-dt * 9)
    this.shake.t += dt
    this.shake.amp *= Math.exp(-dt * 10)
    const pitch = this.pitch + this.recoil + (f.first ? this.vmKick : 0)
    const sx = Math.sin(this.shake.t * 63) * this.shake.amp * 0.04
    const sy = Math.cos(this.shake.t * 51) * this.shake.amp * 0.04
    const viewYaw = this.viewYaw
    const cy = Math.cos(viewYaw)
    const sy0 = Math.sin(viewYaw)
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
    const dead = f.dead
    if (!dead) {
      return
    }
    const body = f.corpseFocus ?? dead
    const bodyY = f.corpseFocus ? f.corpseFocus.y - 0.4 : (dead.y ?? 0)
    this.deadT += dt
    if (this.deadT <= dt) {
      this.deadOrbit = this.yaw + Math.PI
    }
    const separation = Math.max(1.4, (f.corpseRadius ?? 1) + LENS_R + 0.15)
    const cam = this.camera
    const k = f.killer
    const killerY = k?.y ?? 0
    if (k && this.deadT < KILL_CAM_S) {
      // the kill cam: over his shoulder, looking at you where you fell
      const dx = k.x - body.x
      const dz = k.z - body.z
      const d = Math.hypot(dx, dz) || 1
      want.set(
        k.x + (dx / d) * 1.6 + (-dz / d) * 0.6,
        EYE_Y + 0.5 + killerY,
        k.z + (dz / d) * 1.6 + (dx / d) * 0.6,
      )
      const eye = killerY + EYE_Y
      const freeK = cameraClearance(f.grid, k.x, eye, k.z, want.x, want.y, want.z)
      want.set(
        k.x + (want.x - k.x) * freeK,
        eye + (want.y - eye) * freeK,
        k.z + (want.z - k.z) * freeK,
      )
      if (Math.hypot(want.x - body.x, want.y - bodyY - 0.4, want.z - body.z) >= separation) {
        cam.position.lerp(want, this.deadT < 0.05 ? 1 : 1 - Math.exp(-dt * 6))
        if (!deathLensClear(f.grid, body, cam.position, separation)) {
          cam.position.copy(want)
        }
        cam.up.set(0, 1, 0)
        cam.lookAt(body.x, bodyY + 0.6, body.z)
        this.closeness = 0
        return
      }
    }
    const t = Math.min(1, Math.max(0, this.deadT - (k ? KILL_CAM_S : 0)) / 1.2)
    const e = t * t * (3 - 2 * t)
    this.deadOrbit = deathOrbit(
      {
        grid: f.grid,
        focus: body,
        angle: this.deadOrbit + dt * 0.25,
        distance: Math.max(separation, 1.5 + 2.5 * e),
        rise: EYE_Y - 0.4 + 2.2 * e,
        separation,
      },
      want,
    )
    cam.position.lerp(want, 1 - Math.exp(-dt * 4))
    // Lerp chords can cut through the body or an alley corner when the safe angle changes.
    if (!deathLensClear(f.grid, body, cam.position, separation)) {
      cam.position.copy(want)
    }
    cam.up.set(0, 1, 0)
    cam.lookAt(body.x, bodyY + 0.4, body.z)
    this.closeness = 0
  }

  private firstPerson(f: ShooterFrame, dt: number): void {
    const moving = f.grounded ? Math.min(1, f.speed / 5.5) : 0
    this.bobAmp += (moving * (1 - this.ads * 0.7) - this.bobAmp) * (1 - Math.exp(-dt * 8))
    this.bobPhase += dt * (6 + f.speed * 1.4)
    const bob = REDUCED_MOTION ? 0 : this.bobAmp
    const by = Math.abs(Math.sin(this.bobPhase)) * 0.045 * bob
    const bx = Math.cos(this.bobPhase) * 0.025 * bob
    const yaw = this.viewYaw
    this.camera.position.set(
      this.pivot.x + Math.cos(yaw) * 0.12 + right.x * bx,
      this.pivot.y - PIVOT_Y + EYE_Y + by - 0.02 * bob,
      this.pivot.z + Math.sin(yaw) * 0.12 + right.z * bx,
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
      cameraClearance(
        f.grid,
        this.pivot.x,
        this.pivot.y,
        this.pivot.z,
        this.pivot.x + right.x * s,
        this.pivot.y,
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
    // walls: from the body's centre to the shoulder, then on to the lens
    const shoulderFree = cameraClearance(
      f.grid,
      this.pivot.x,
      this.pivot.y,
      this.pivot.z,
      px,
      py,
      pz,
    )
    const sideK = Math.min(shoulderFree, 1)
    const sx = this.pivot.x + (px - this.pivot.x) * sideK
    const sz = this.pivot.z + (pz - this.pivot.z) * sideK
    const sy = this.pivot.y + (py - this.pivot.y) * sideK
    want.set(sx - fwd.x * this.back, sy - fwd.y * this.back, sz - fwd.z * this.back)
    const free = cameraClearance(f.grid, sx, sy, sz, want.x, want.y, want.z)
    const target = this.back * free
    // in at once, out gently
    this.reach = target < this.reach ? target : this.reach + (target - this.reach) * ease(5)
    const k = this.back > 0 ? this.reach / this.back : 1
    this.camera.position.set(
      sx - fwd.x * this.back * k,
      Math.max(MIN_Y, sy - fwd.y * this.back * k),
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

const LENS_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const

/**
 * Fraction of a padded 3D camera sweep that is clear. The seven rays protect the lens's centre
 * and its horizontal/vertical extent; roofs and upper floors count at their real elevation.
 */
export function cameraClearance(
  grid: Grid,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius = LENS_R,
  pad = WALL_PAD,
): number {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const d = Math.hypot(dx, dy, dz)
  if (d < 1e-4) {
    return 1
  }
  const max = d + pad
  let hit = max
  for (const [ox, oy, oz] of LENS_OFFSETS) {
    const x = ax + ox * radius
    const y = ay + oy * radius
    const z = az + oz * radius
    const found = rayWorld(grid, x, y, z, dx / d, dy / d, dz / d, max)
    if (found) {
      hit = Math.min(hit, found.dist)
    }
  }
  return hit === max ? 1 : Math.max(0, (hit - pad) / d)
}

export function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

interface DeathOrbit {
  grid: Grid
  focus: { x: number; y?: number; z: number }
  angle: number
  distance: number
  rise: number
  separation: number
}

function deathLensClear(
  grid: Grid,
  focus: DeathOrbit['focus'],
  lens: Vector3,
  separation: number,
): boolean {
  if (Math.hypot(lens.x - focus.x, lens.y - (focus.y ?? 0), lens.z - focus.z) < separation) {
    return false
  }
  for (const [x, y, z] of LENS_OFFSETS) {
    if (
      rayWorld(grid, lens.x + x * LENS_R, lens.y + y * LENS_R, lens.z + z * LENS_R, 0, 1, 0, 0.01)
    ) {
      return false
    }
  }
  return true
}

/** Choose an open angle/height instead of shortening a blocked boom into the dressed body. */
export function deathOrbit(options: DeathOrbit, out: Vector3): number {
  const { grid, focus, distance, separation } = options
  const y = focus.y ?? 0
  for (const lift of [0, 1.5, 3]) {
    for (const offset of ORBIT_OFFSETS) {
      const angle = options.angle + offset
      out.set(
        focus.x + Math.cos(angle) * distance,
        y + options.rise + lift,
        focus.z + Math.sin(angle) * distance,
      )
      const free = cameraClearance(grid, focus.x, y + 0.2, focus.z, out.x, out.y, out.z, 0, LENS_R)
      if (free > 0.99 && deathLensClear(grid, focus, out, separation)) {
        return angle
      }
    }
  }
  // A small enclosed room may have no full-length sightline. Keep the lens outside solid
  // architecture and the body; the death cutaway clears the intervening foreground.
  for (const lift of [1.5, 3, 6]) {
    for (const offset of ORBIT_OFFSETS) {
      const angle = options.angle + offset
      out.set(
        focus.x + Math.cos(angle) * distance,
        y + options.rise + lift,
        focus.z + Math.sin(angle) * distance,
      )
      if (deathLensClear(grid, focus, out, separation)) {
        return angle
      }
    }
  }
  return options.angle
}
