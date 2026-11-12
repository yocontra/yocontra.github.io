import { type Entity, math, Quat, Vec3 } from 'playcanvas'

export interface Pose {
  pos: Vec3
  look: Vec3
  fov: number
  roll?: number
  /** Handheld noise amplitude in degrees. */
  handheld?: number
}

export type ShotFn = (t: number, dt: number) => Pose

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))
export const V = (x = 0, y = 0, z = 0): Vec3 => new Vec3(x, y, z)

const lerpVec = (a: Vec3, b: Vec3, k: number): Vec3 => new Vec3().lerp(a, b, k)

/**
 * Shot-based duel camera: named cuts or eased blends between shot functions, handheld drift and a
 * trauma shake. Poses are computed on the real clock, so slow-motion never slows the lens.
 */
export class CameraRig {
  name = ''
  trauma = 0
  decay = 1.5
  reduced = false as boolean
  private shot: ShotFn | null = null
  private t = 0
  private noiseT = 0
  private blend = 0
  private hasLast = false as boolean
  private readonly from = { pos: new Vec3(), look: new Vec3(), fov: 40, roll: 0 }
  private readonly last = { pos: new Vec3(), look: new Vec3(0, 0, 1), fov: 40, roll: 0 }
  private readonly camera: Entity
  private readonly q = new Quat()
  constructor(camera: Entity) {
    this.camera = camera
  }

  /** Switch to a new shot; with `blend` > 0 ease from the current framing over that many seconds. */
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

  /** Hand the camera back to another owner (the hub); the next cut starts without a blend. */
  release(): void {
    this.shot = null
    this.name = ''
    this.hasLast = false
    this.trauma = 0
  }

  get active(): boolean {
    return this.shot !== null
  }

  get shotTime(): number {
    return this.t
  }

  /** Where the camera framed the last frame (before shake). */
  pose(): Pose {
    return {
      pos: this.last.pos.clone(),
      look: this.last.look.clone(),
      fov: this.last.fov,
      roll: this.last.roll,
    }
  }

  addTrauma(v: number): void {
    if (!this.reduced) {
      this.trauma = Math.min(1, this.trauma + v)
    }
  }

  update(dt: number): void {
    if (!this.shot) {
      return
    }
    this.t += dt
    this.noiseT += dt
    const p = this.shot(this.t, dt)
    if (this.blend > 0 && this.t < this.blend) {
      const k = easeInOutCubic(this.t / this.blend)
      p.pos = lerpVec(this.from.pos, p.pos, k)
      p.look = lerpVec(this.from.look, p.look, k)
      p.fov = math.lerp(this.from.fov, p.fov, k)
      p.roll = math.lerp(this.from.roll, p.roll ?? 0, k)
      p.handheld = (p.handheld ?? 0) * k
    }
    this.last.pos.copy(p.pos)
    this.last.look.copy(p.look)
    this.last.fov = p.fov
    this.last.roll = p.roll ?? 0
    this.hasLast = true
    const cam = this.camera
    cam.setPosition(p.pos)
    cam.lookAt(p.look)
    const hh = this.reduced ? 0 : (p.handheld ?? 0) * 0.5
    const shake = this.trauma * this.trauma
    const n = this.noiseT
    const yaw =
      hh * (Math.sin(n * 1.1) * 0.6 + Math.sin(n * 2.3 + 1) * 0.4) +
      math.RAD_TO_DEG * shake * 0.035 * (Math.sin(n * 23) * 0.6 + Math.sin(n * 37 + 2) * 0.4)
    const pitch =
      hh * (Math.sin(n * 1.7 + 3) * 0.6 + Math.sin(n * 3.1) * 0.4) +
      math.RAD_TO_DEG * shake * 0.035 * (Math.sin(n * 29 + 1) * 0.6 + Math.sin(n * 41) * 0.4)
    const roll = math.RAD_TO_DEG * ((p.roll ?? 0) + shake * 0.02 * Math.sin(n * 31 + 4))
    this.q.setFromEulerAngles(pitch, yaw, roll)
    cam.setRotation(cam.getRotation().clone().mul(this.q))
    if (cam.camera && cam.camera.fov !== p.fov) {
      cam.camera.fov = p.fov
    }
    this.trauma = Math.max(0, this.trauma - this.decay * dt)
  }
}

export interface OrbitOpts {
  /** The point the camera swings around. */
  pivot: Vec3
  /** Progress, 0..1 (already eased). */
  k: number
  /** Bows the path out by this much at the halfway point. */
  bend?: Vec3
}

/** A pose on an arc from `from` to `to` around `pivot`: it swings around a gun, not through it. */
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
  const r = math.lerp(Math.hypot(ax, az), Math.hypot(bx, bz), k)
  const y = math.lerp(from.pos.y, to.pos.y, k)
  const pos = V(pivot.x + Math.sin(a) * r, y, pivot.z + Math.cos(a) * r)
  if (o.bend) {
    pos.add(o.bend.clone().mulScalar(4 * k * (1 - k)))
  }
  return {
    pos,
    look: lerpVec(from.look, to.look, k),
    fov: math.lerp(from.fov, to.fov, k),
    roll: math.lerp(from.roll ?? 0, to.roll ?? 0, k),
    handheld: math.lerp(from.handheld ?? 0, to.handheld ?? 0, k),
  }
}

export interface Framing {
  pos: Vec3
  look: Vec3
  fov: number
}

/** Half a man's width at the shoulders, m. */
const SHOULDER = 0.28

interface Placement {
  portrait: boolean
  back: number
  side: number
  sNdc: number
  ang: number
  dV: number
}

function placementScore(p: Placement): number {
  let score = Math.abs(p.back - (p.portrait ? 4.6 : 3.4)) / 8
  const edge = p.portrait ? 1 : 0.8
  if (p.sNdc > edge) {
    score += (p.sNdc - edge) * 10
  }
  if (p.sNdc < 0.4) {
    score += (0.4 - p.sNdc) * 6
  }
  if (p.portrait) {
    const clear = Math.abs(p.ang) - Math.atan(SHOULDER / p.back) - Math.atan(SHOULDER / p.dV)
    return score + Math.max(0, -clear) * 40
  }
  return score + Math.abs(math.RAD_TO_DEG * Math.atan2(p.side, p.back) - 32) / 25
}

/** Rotate `v` about +Y by `a` radians. */
function yawed(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return V(v.x * c + v.z * s, v.y, -v.x * s + v.z * c)
}

/**
 * The kill-cam two-shot: behind the shooter on his gun side, about 30° off the duel axis, the
 * victim on one third and the shooter on the other. Tries a grid of placements, keeps the best.
 */
export function twoShot(
  shooter: Vec3,
  victim: Vec3,
  aspect: number,
  opts: { height?: number; frac?: number; side?: 1 | -1 } = {},
): Framing {
  const side = opts.side ?? 1
  const portrait = aspect < 1
  const frac = opts.frac ?? (portrait ? 0.26 : 0.4)
  const victimHeight = opts.height ?? 1.78
  const axis = V(victim.x - shooter.x, 0, victim.z - shooter.z)
  const sep = Math.max(0.4, axis.length())
  axis.mulScalar(1 / sep)
  // the shooter's right-hand side while he faces the victim
  const right = V(-axis.z, 0, axis.x).mulScalar(side)
  const vC = V(victim.x, victimHeight * 0.53, victim.z)
  const sC = V(shooter.x, 1.3, shooter.z)
  const backs = [2.4, 3.0, 3.6, 4.4, 5.4]
  const sides = portrait ? [0.3, 0.45, 0.65, 0.9, 1.2] : [1.1, 1.5, 1.9, 2.4, 2.9]
  let best: Framing | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const back of backs) {
    for (const so of sides) {
      const pos = shooter
        .clone()
        .add(axis.clone().mulScalar(-back))
        .add(right.clone().mulScalar(so))
      pos.y = 1.4
      const dV = pos.distance(vC)
      const vfov = math.clamp(2 * Math.atan(victimHeight / (2 * frac * dV)), 0.24, 0.9)
      const hHalf = Math.atan(Math.tan(vfov / 2) * aspect)
      const toV = V(vC.x - pos.x, 0, vC.z - pos.z).normalize()
      const toS = V(sC.x - pos.x, 0, sC.z - pos.z).normalize()
      const ang = Math.atan2(toV.z * toS.x - toV.x * toS.z, toV.dot(toS))
      const ov = Math.atan(Math.tan(hHalf) * (portrait ? 0 : 1 / 3))
      const sNdc = Math.tan(Math.abs(ang) - ov) / Math.tan(hHalf)
      const score = placementScore({ portrait, back, side: so, sNdc, ang, dV })
      if (score < bestScore) {
        bestScore = score
        const aim = yawed(toV, Math.sign(ang) * ov)
        const flat = Math.hypot(vC.x - pos.x, vC.z - pos.z)
        const look = pos.clone().add(aim.mulScalar(flat))
        look.y = vC.y
        best = { pos, look, fov: math.RAD_TO_DEG * vfov }
      }
    }
  }
  return best ?? { pos: shooter.clone().add(V(0, 1.4, -3)), look: vC, fov: 30 }
}

/** Vertical fov (degrees) that keeps every point inside the frame, with a margin, from pos→look. */
export function fitFov(pos: Vec3, look: Vec3, points: Vec3[], aspect: number): number {
  const fwd = look.clone().sub(pos).normalize()
  const right = new Vec3().cross(fwd, Vec3.UP).normalize()
  const up = new Vec3().cross(right, fwd)
  let tanV = 0
  for (const p of points) {
    const d = p.clone().sub(pos)
    const z = Math.max(0.1, d.dot(fwd))
    tanV = Math.max(tanV, Math.abs(d.dot(up)) / z, Math.abs(d.dot(right)) / z / aspect)
  }
  return math.RAD_TO_DEG * 2 * Math.atan(tanV * 1.3)
}
