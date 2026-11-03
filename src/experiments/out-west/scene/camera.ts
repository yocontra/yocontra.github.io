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

  addTrauma(v: number): void {
    if (this.reduced) return
    this.trauma = Math.min(1, this.trauma + v)
  }

  update(dt: number, realDt: number): void {
    this.t += dt
    this.noiseT += realDt
    if (!this.shot) return
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

/** Distance to keep a subject the same size when FOV changes (dolly zoom). */
export function dollyDistance(d: number, fovFrom: number, fovTo: number): number {
  return (d * Math.tan(MathUtils.degToRad(fovFrom) / 2)) / Math.tan(MathUtils.degToRad(fovTo) / 2)
}
