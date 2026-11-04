// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three'

export interface Pose {
  pos: Vector3
  look: Vector3
  fov: number
  roll?: number
  /** Handheld noise amplitude in degrees. */
  handheld?: number
}

export type ShotFn = (t: number, dt: number) => Pose

/** Shot-based camera with a trauma shake model (design doc §4.2). */
export class CameraRig {
  readonly cam: PerspectiveCamera
  private shot: ShotFn | null = null
  private t = 0
  trauma = 0
  decay = 1.5
  reduced = false
  private noiseT = 0
  name = ''
  private readonly up = new Vector3(0, 1, 0)
  private readonly q = new Quaternion()
  private readonly fwd = new Vector3()

  constructor(aspect: number) {
    this.cam = new PerspectiveCamera(40, aspect, 0.08, 1200)
  }

  private blend = 0
  private readonly from = { pos: new Vector3(), look: new Vector3(), fov: 40, roll: 0 }
  private readonly last = { pos: new Vector3(), look: new Vector3(0, 0, 1), fov: 40, roll: 0 }
  private hasLast = false

  /**
   * Switch to a new shot. With `blend` > 0 the camera eases from where it is
   * into the new shot over that many seconds instead of cutting.
   */
  cut(name: string, fn: ShotFn, blend = 0): void {
    this.name = name
    this.shot = fn
    this.t = 0
    this.blend = this.hasLast ? blend : 0
    this.from.pos.copy(this.last.pos)
    this.from.look.copy(this.last.look)
    this.from.fov = this.last.fov
    this.from.roll = this.last.roll
  }

  get shotTime(): number {
    return this.t
  }

  /** Where the camera framed the last frame (before shake), to move on from without a cut. */
  pose(): Pose {
    return {
      pos: this.last.pos.clone(),
      look: this.last.look.clone(),
      fov: this.last.fov,
      roll: this.last.roll,
    }
  }

  addTrauma(v: number): void {
    if (this.reduced) {
      return
    }
    this.trauma = Math.min(1, this.trauma + v)
  }

  update(dt: number, realDt: number): void {
    this.t += dt
    this.noiseT += realDt
    if (!this.shot) {
      return
    }
    const p = this.shot(this.t, dt)
    if (this.blend > 0 && this.t < this.blend) {
      const k = easeInOutCubic(this.t / this.blend)
      p.pos = this.from.pos.clone().lerp(p.pos, k)
      p.look = this.from.look.clone().lerp(p.look, k)
      p.fov = MathUtils.lerp(this.from.fov, p.fov, k)
      p.roll = MathUtils.lerp(this.from.roll, p.roll ?? 0, k)
      p.handheld = (p.handheld ?? 0) * k
    }
    this.last.pos.copy(p.pos)
    this.last.look.copy(p.look)
    this.last.fov = p.fov
    this.last.roll = p.roll ?? 0
    this.hasLast = true
    const cam = this.cam
    cam.position.copy(p.pos)
    cam.up.copy(this.up)
    cam.lookAt(p.look)
    if (p.roll) {
      this.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion)
      this.q.setFromAxisAngle(this.fwd, p.roll)
      cam.quaternion.premultiply(this.q)
    }
    const hh = this.reduced ? 0 : (p.handheld ?? 0) * 0.5
    const shake = this.trauma * this.trauma
    const n = this.noiseT
    const yaw =
      MathUtils.degToRad(hh * (Math.sin(n * 1.1) * 0.6 + Math.sin(n * 2.3 + 1) * 0.4)) +
      shake * 0.035 * (Math.sin(n * 23) * 0.6 + Math.sin(n * 37 + 2) * 0.4)
    const pitch =
      MathUtils.degToRad(hh * (Math.sin(n * 1.7 + 3) * 0.6 + Math.sin(n * 3.1) * 0.4)) +
      shake * 0.035 * (Math.sin(n * 29 + 1) * 0.6 + Math.sin(n * 41) * 0.4)
    const roll = shake * 0.02 * Math.sin(n * 31 + 4)
    cam.rotateY(yaw)
    cam.rotateX(pitch)
    cam.rotateZ(roll)
    if (cam.fov !== p.fov) {
      cam.fov = p.fov
      cam.updateProjectionMatrix()
    }
    this.trauma = Math.max(0, this.trauma - this.decay * realDt)
  }
}

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))

export interface OrbitOpts {
  /** The point the camera swings around. */
  pivot: Vector3
  /** Progress, 0..1 (already eased). */
  k: number
  /** Bows the path out by this much at the halfway point (a smooth parabola: no kink). */
  bend?: Vector3
}

/**
 * A pose on an arc from `from` to `to` around `pivot` at progress `k`: the camera's bearing around
 * the pivot turns the short way, its distance and height glide, and the look point, field of view
 * and roll glide with it. With the pivot at a gun the camera swings around the gun instead of
 * sliding through it.
 */
export function orbitPose(from: Pose, to: Pose, o: OrbitOpts): Pose {
  const { pivot, k } = o
  const ax = from.pos.x - pivot.x
  const az = from.pos.z - pivot.z
  const bx = to.pos.x - pivot.x
  const bz = to.pos.z - pivot.z
  const a0 = Math.atan2(ax, az)
  let da = Math.atan2(bx, bz) - a0
  da = Math.atan2(Math.sin(da), Math.cos(da))
  const a = a0 + da * k
  const r = MathUtils.lerp(Math.hypot(ax, az), Math.hypot(bx, bz), k)
  const y = MathUtils.lerp(from.pos.y, to.pos.y, k)
  const pos = new Vector3(pivot.x + Math.sin(a) * r, y, pivot.z + Math.cos(a) * r)
  if (o.bend) {
    pos.addScaledVector(o.bend, 4 * k * (1 - k))
  }
  return {
    pos,
    look: from.look.clone().lerp(to.look, k),
    fov: MathUtils.lerp(from.fov, to.fov, k),
    roll: MathUtils.lerp(from.roll ?? 0, to.roll ?? 0, k),
    handheld: MathUtils.lerp(from.handheld ?? 0, to.handheld ?? 0, k),
  }
}

/** Distance to keep a subject the same size when FOV changes (dolly zoom). */
export function dollyDistance(d: number, fovFrom: number, fovTo: number): number {
  return (d * Math.tan(MathUtils.degToRad(fovFrom) / 2)) / Math.tan(MathUtils.degToRad(fovTo) / 2)
}

/** Half a man's width at the shoulders, m (for keeping the shooter off the victim). */
const SHOULDER = 0.28

export interface Framing {
  pos: Vector3
  look: Vector3
  fov: number
}

/**
 * The kill-cam two-shot: from behind the shooter on his gun side, about 30°
 * off the duel axis, with the victim filling `frac` of the frame height on a
 * third (centred on portrait screens) and the shooter in frame on the other
 * side (on a portrait screen he may be cut at the edge, but never covers the victim). Tries a few camera placements and keeps the best-composed one.
 */
export interface TwoShotOpts {
  /** Victim's height in metres. */
  height?: number
  /** Share of the frame height the victim fills. */
  frac?: number
  /** 1 = the shooter's right (gun) side, -1 = his left. */
  side?: 1 | -1
}

interface Placement {
  portrait: boolean
  /** Metres behind the shooter, and out to his side. */
  back: number
  side: number
  /** Where the shooter's centre lands across the frame (0 centre, 1 edge). */
  sNdc: number
  /** Horizontal angle from the victim to the shooter, rad; distance to the victim, m. */
  ang: number
  dV: number
}

/** How badly a two-shot placement composes (lower is better). */
function placementScore(p: Placement): number {
  let score = Math.abs(p.back - 3.4) / 8
  // a narrow frame may cut the shooter at its edge (his gun arm stays in), never hide the victim
  const edge = p.portrait ? 1 : 0.8
  if (p.sNdc > edge) {
    score += (p.sNdc - edge) * 10
  }
  if (p.sNdc < 0.4) {
    score += (0.4 - p.sNdc) * 6
  }
  if (p.portrait) {
    // the angle between the shooter's near shoulder and the victim's far side
    const clear = Math.abs(p.ang) - Math.atan(SHOULDER / p.back) - Math.atan(SHOULDER / p.dV)
    return score + Math.max(0, -clear) * 40
  }
  return score + Math.abs(MathUtils.radToDeg(Math.atan2(p.side, p.back)) - 32) / 25
}

export function twoShot(
  shooter: Vector3,
  victim: Vector3,
  aspect: number,
  opts: TwoShotOpts = {},
): Framing {
  const side = opts.side ?? 1
  const frac = opts.frac ?? 0.4
  const victimHeight = opts.height ?? 1.78
  const axis = new Vector3(victim.x - shooter.x, 0, victim.z - shooter.z)
  const sep = Math.max(0.4, axis.length())
  axis.divideScalar(sep)
  // the shooter's right-hand side while he faces the victim
  const right = new Vector3(-axis.z, 0, axis.x).multiplyScalar(side)
  const portrait = aspect < 1
  const vC = new Vector3(victim.x, victimHeight * 0.53, victim.z)
  const sC = new Vector3(shooter.x, 1.3, shooter.z)
  const backs = [2.4, 3.0, 3.6, 4.4, 5.4]
  const sides = portrait ? [0.3, 0.45, 0.65, 0.9, 1.2] : [1.1, 1.5, 1.9, 2.4, 2.9]
  const up = new Vector3(0, 1, 0)
  const toV = new Vector3()
  const toS = new Vector3()
  let best: Framing | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const back of backs) {
    for (const so of sides) {
      const pos = shooter.clone().addScaledVector(axis, -back).addScaledVector(right, so)
      pos.y = 1.4
      const dV = pos.distanceTo(vC)
      const vfov = MathUtils.clamp(2 * Math.atan(victimHeight / (2 * frac * dV)), 0.24, 0.9)
      const hHalf = Math.atan(Math.tan(vfov / 2) * aspect)
      toV.set(vC.x - pos.x, 0, vC.z - pos.z).normalize()
      toS.set(sC.x - pos.x, 0, sC.z - pos.z).normalize()
      // signed horizontal angle from the victim to the shooter
      const ang = Math.atan2(toV.z * toS.x - toV.x * toS.z, toV.dot(toS))
      const ov = Math.atan(Math.tan(hHalf) * (portrait ? 0 : 1 / 3))
      const sNdc = Math.tan(Math.abs(ang) - ov) / Math.tan(hHalf)
      const score = placementScore({ portrait, back, side: so, sNdc, ang, dV })
      if (score < bestScore) {
        bestScore = score
        // turn from the victim toward the shooter by `ov`: victim on one third, shooter on the other
        const aim = toV.clone().applyAxisAngle(up, Math.sign(ang) * ov)
        const flat = Math.hypot(vC.x - pos.x, vC.z - pos.z)
        const look = pos.clone().addScaledVector(aim, flat)
        look.y = vC.y
        best = { pos, look, fov: MathUtils.radToDeg(vfov) }
      }
    }
  }
  return best ?? { pos: shooter.clone().add(new Vector3(0, 1.4, -3)), look: vC, fov: 30 }
}
