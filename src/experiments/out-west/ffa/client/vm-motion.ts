/**
 * The first-person gun's motion, CoD style, as pure numbers (no three.js): where the gun sits
 * relative to its resting hold this frame, and how it's turned. `viewmodel.ts` applies it.
 *
 * - The sights: 0.17 s in and out (ease in-out), with less sway and bob on the sights.
 * - Look inertia: the gun lags the turn and springs back.
 * - Idle breathing; a walk / run bob tied to your speed (a figure eight, bigger on the run).
 * - Sprint: the gun comes up and cants in, muzzle high, the way a pistol is carried at a run; out of a sprint it comes up over
 *   `SPRINT_OUT_S` (the sim's sprint-to-fire delay), so it's on target when the shot goes.
 * - Crouch dips it, a slide cants it hard, a jump lifts it and the landing kicks it down.
 * - Every shot: a kick back and up with a little sideways from a fixed pattern, and a spring back.
 * - Reload (the revolver): the gun rolls out to open the gate, flicks up to dump the empties,
 *   three loading dips while the support hand works, then a snap closed.
 * - Rifle: the lever cycles after each shot. Coach gun: a heavy rock back.
 * - Swap and draw: the gun comes up from below the frame on spawn and on every weapon change.
 *
 * Positions are metres in camera space (+x right, +y up, −z ahead); angles are radians
 * (pitch up, yaw left, roll counter-clockwise).
 */
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'

export const ADS_S = 0.17
export const DRAW_S = 0.38
export const SPRINT_OUT_S = 0.15

export interface VmPose {
  x: number
  y: number
  z: number
  pitch: number
  yaw: number
  roll: number
  /** The sights blend, 0 hip … 1 aimed (eased). */
  ads: number
  /** The support hand's extra reach while loading (m, toward the gun's gate), 0 at rest. */
  load: number
  /** The view's own kick (rad): the world camera pitches up by this and settles. */
  viewKick: number
}

export interface VmInput {
  dt: number
  /** This frame's look turn (rad). */
  lookYaw: number
  lookPitch: number
  /** Planar speed (m/s). */
  speed: number
  sprinting: boolean
  ads: boolean
  crouched: boolean
  sliding: boolean
  /** Height of a jump arc right now (m); 0 on the ground. */
  lift: number
  /** 0..1 through a reload, or null. */
  reload: number | null
  weapon: number
  /** Distance to a wall ahead (m): the gun pulls back off it. */
  wall: number
}

/** A critically damped spring toward 0 (stiffness `k`), as plain state. */
interface Spring {
  v: number
  x: number
  k: number
}
const spring = (k: number): Spring => ({ v: 0, x: 0, k })
function stepSpring(s: Spring, dt: number): number {
  const w = Math.sqrt(s.k)
  s.v += (-s.k * s.x - 2 * w * s.v) * dt
  s.x += s.v * dt
  return s.x
}

/** The revolver's recoil pattern: sideways kicks (fractions of the base), repeating. */
const PATTERN = [0.2, -0.35, 0.5, -0.1, 0.35, -0.5]
const ease = (t: number): number => t * t * (3 - 2 * t)
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))
/** A 0→1→0 bump over [a, b] of t. */
const bump = (t: number, a: number, b: number): number =>
  t <= a || t >= b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI)

export class VmMotion {
  readonly pose: VmPose = {
    x: 0,
    y: 0,
    z: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    ads: 0,
    load: 0,
    viewKick: 0,
  }
  private adsT = 0
  private swayX = 0
  private swayY = 0
  private bobPhase = 0
  private bobAmp = 0
  private breath = 0
  private sprint = 0
  private crouch = 0
  private slide = 0
  private wall = 0
  private lastLift = 0
  private air = 0
  private readonly land = spring(260)
  private readonly kickZ = spring(320)
  private readonly kickP = spring(220)
  private readonly kickY = spring(260)
  private readonly view = spring(160)
  private shots = 0
  /** Seconds since the last shot, and the weapon it came from (for the lever and the rock). */
  private sinceShot = 9
  private shotWeapon = 0
  /** Seconds into the draw (≥ DRAW_S once up). */
  private draw = 0
  private weapon = -1

  /** A shot left the gun. */
  fired(weapon: number): void {
    const long = weapon === WEAPON_RIFLE || weapon === WEAPON_SHOTGUN
    let k = long ? 1.25 : 1
    if (weapon === WEAPON_SHOTGUN) {
      k = 1.6
    }
    const side = PATTERN[this.shots % PATTERN.length] ?? 0
    this.shots++
    const aimK = 1 - this.adsT * 0.45
    this.kickZ.v += 1.5 * k
    this.kickP.v += 9 * k * aimK
    this.kickY.v += side * 4 * k * aimK
    this.view.v += (long ? 1.4 : 0.9) * aimK
    this.sinceShot = 0
    this.shotWeapon = weapon
  }

  /** Bring the gun up from below the frame (spawn, a pickup, back to the revolver). */
  redraw(): void {
    this.draw = 0
  }

  update(i: VmInput): VmPose {
    const dt = Math.min(0.05, i.dt)
    const p = this.pose
    const e = (rate: number) => 1 - Math.exp(-dt * rate)
    if (i.weapon !== this.weapon) {
      this.weapon = i.weapon
      this.redraw()
    }
    this.draw = Math.min(DRAW_S, this.draw + dt)
    this.sinceShot += dt
    // the sights: a fixed-time ease, not a filter, so it's crisp both ways
    const busy = i.reload !== null || i.sprinting || this.draw < DRAW_S * 0.7
    const adsStep = dt / ADS_S
    this.adsT = clamp01(this.adsT + (i.ads && !busy ? adsStep : -adsStep))
    const ads = ease(this.adsT)
    p.ads = ads
    const calm = 1 - ads * 0.85
    // look inertia: lag the turn, spring back
    this.swayX += (Math.max(-0.06, Math.min(0.06, -i.lookYaw * 1.3)) * calm - this.swayX) * e(9)
    this.swayY += (Math.max(-0.05, Math.min(0.05, i.lookPitch * 1.3)) * calm - this.swayY) * e(9)
    // bob: a figure eight with the stride, bigger and faster on the run and the sprint
    const ground = this.air < 0.05 && !i.sliding
    const stride = ground ? Math.min(1.4, i.speed / 5.5) : 0
    this.bobAmp += (stride * calm - this.bobAmp) * e(8)
    this.bobPhase += dt * (4.5 + i.speed * 1.25)
    this.breath += dt * 1.6
    const bx = Math.sin(this.bobPhase) * 0.012 * this.bobAmp
    const by = -Math.abs(Math.cos(this.bobPhase)) * 0.016 * this.bobAmp
    const breathe = Math.sin(this.breath) * 0.0018 * (1 - ads * 0.7)
    // stances
    this.sprint +=
      ((i.sprinting ? 1 : 0) - this.sprint) * (i.sprinting ? e(10) : e((1 / SPRINT_OUT_S) * 3))
    this.crouch += ((i.crouched ? 1 : 0) - this.crouch) * e(10)
    this.slide += ((i.sliding ? 1 : 0) - this.slide) * e(12)
    this.wall += (Math.min(0.3, Math.max(0, 0.75 - i.wall)) - this.wall) * e(14)
    // jump: the gun floats up a touch in the air and kicks down on the landing
    this.air += ((i.lift > 0.02 ? 1 : 0) - this.air) * e(10)
    if (this.lastLift > 0.02 && i.lift <= 0.02) {
      this.land.v -= 1.2
    }
    this.lastLift = i.lift
    const land = stepSpring(this.land, dt)
    const kz = stepSpring(this.kickZ, dt)
    const kp = stepSpring(this.kickP, dt)
    const ky = stepSpring(this.kickY, dt)
    p.viewKick = stepSpring(this.view, dt) * 0.04
    // reload choreography (revolver), on its own 0..1 clock
    let rx = 0
    let ry = 0
    let rRoll = 0
    let rPitch = 0
    let load = 0
    const r = i.reload
    if (r !== null) {
      const open = ease(clamp01(r / 0.14)) * (1 - ease(clamp01((r - 0.86) / 0.1)))
      rRoll = open * 0.95
      rx = -open * 0.05
      ry = open * 0.03
      rPitch = open * 0.35 + bump(r, 0.14, 0.28) * 0.55
      // three loading dips
      const loading = clamp01((r - 0.3) / 0.52)
      load = r > 0.3 && r < 0.82 ? Math.abs(Math.sin(loading * Math.PI * 3)) : 0
      ry -= load * 0.01
      // the snap closed
      rRoll -= bump(r, 0.86, 0.95) * 0.25
    }
    p.load = load
    // the rifle's lever after a shot, the coach gun's rock
    let lever = 0
    if (this.shotWeapon === WEAPON_RIFLE) {
      lever = bump(this.sinceShot, 0.18, 0.62)
    }
    const rock = this.shotWeapon === WEAPON_SHOTGUN ? bump(this.sinceShot, 0, 0.45) : 0
    // the draw: up from below, turning in
    const d = 1 - ease(this.draw / DRAW_S)
    const sp = this.sprint * (1 - this.slide)
    p.x = this.swayX + bx + rx + sp * 0.015 + this.slide * -0.03 + d * 0.06
    p.y =
      this.swayY +
      by +
      breathe +
      ry +
      sp * -0.02 +
      this.crouch * -0.012 +
      this.air * 0.012 +
      land * 0.03 +
      lever * -0.035 -
      this.wall * 0.12 -
      d * 0.22
    p.z = kz * 0.035 + this.wall + sp * -0.03 + rock * 0.05
    p.pitch =
      kp * 0.06 +
      this.swayY * 1.6 +
      rPitch +
      sp * 0.55 +
      land * -0.25 +
      lever * -0.18 +
      rock * 0.12 +
      d * -0.9
    p.yaw = ky * 0.05 + this.swayX * 1.6 + sp * 0.35 + d * 0.3
    p.roll =
      -this.swayX * 1.4 + rRoll + sp * 0.55 + this.slide * 0.45 + lever * 0.3 + bx * 2 + d * 0.4
    return p
  }
}
