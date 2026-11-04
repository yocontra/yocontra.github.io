/**
 * The hands in a quick-draw (scene/draw.ts): which revolver each holds, the gun changing hands
 * between holster and fist with no pop, its place in the fist (and the twirl), and the off hand's
 * target when it steadies the grip or fans the hammer.
 */
import { type Bone, MathUtils, type Object3D, Quaternion, Vector3 } from 'three'
import { fanWrist, type GunPose, gunInHand, gunPose, worldOf } from './draw-pose.ts'
import type { GunAnatomy } from './holster.ts'

/** One gun hand: its revolver, the holster slot it hangs in, the seat in the fist. */
export interface GunHand {
  side: 'R' | 'L'
  gun: Object3D
  holster: Object3D
  slot: Object3D
}

/** What the layer needs of the man (scene/actor.ts). */
export interface Armed {
  readonly root: Object3D
  readonly height: number
  gun: Object3D | null
  offGun: Object3D | null
  holster: Object3D | null
  handSlot: Object3D | null
  offHolster: Object3D | null
  offSlot: Object3D | null
}

export interface HandState {
  h: GunHand
  wrist: Bone
  upper: Bone
  lower: Bone
  /** The clip's wrist and elbow this frame, in his chest's frame. */
  clipP: Vector3
  clipQ: Quaternion
  elbow: Vector3
  /** The gun's local offset in the fist after a hand-off, decaying to nothing. */
  offP: Vector3
  offQ: Quaternion
  kick: number
}

export const UP = new Vector3(0, 1, 0)
export const ease = (k: number): number => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
export const smooth = (a: number, b: number, x: number): number => {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** His revolvers with their holsters and seats in the fist, strong hand first. */
function gunHands(m: Armed): GunHand[] {
  const out: GunHand[] = []
  if (m.gun && m.holster && m.handSlot) {
    out.push({ side: 'R', gun: m.gun, holster: m.holster, slot: m.handSlot })
  }
  if (m.offGun && m.offHolster && m.offSlot) {
    out.push({ side: 'L', gun: m.offGun, holster: m.offHolster, slot: m.offSlot })
  }
  return out
}

export function handStates(m: Armed, bone: (n: string) => Bone | null): HandState[] {
  const out: HandState[] = []
  for (const h of gunHands(m)) {
    const wrist = bone(`Wrist${h.side}`)
    const upper = bone(`UpperArm${h.side}`)
    const lower = bone(`LowerArm${h.side}`)
    if (wrist && upper && lower) {
      out.push({
        h,
        wrist,
        upper,
        lower,
        clipP: new Vector3(),
        clipQ: new Quaternion(),
        elbow: new Vector3(),
        offP: new Vector3(),
        offQ: new Quaternion(),
        kick: 0,
      })
    }
  }
  return out
}

/**
 * Into the fist from the holster, keeping its place in the world (the offset then decays as the
 * hand settles on it); `snap` seats it at once (a shot that can't wait).
 */
export function toHand(s: HandState, snap: boolean): void {
  const gun = s.h.gun
  // only from the holster (a gun the boss dropped is the physics' now)
  if (gun.parent !== s.h.holster) {
    return
  }
  gun.updateWorldMatrix(true, false)
  const m = gun.matrixWorld.clone()
  s.h.slot.add(gun)
  s.h.slot.updateWorldMatrix(true, false)
  s.h.slot.matrixWorld.clone().invert().multiply(m).decompose(s.offP, s.offQ, new Vector3())
  if (snap) {
    s.offP.set(0, 0, 0)
    s.offQ.identity()
  }
  gun.position.copy(s.offP)
  gun.quaternion.copy(s.offQ)
}

export function toHolster(s: HandState): void {
  const gun = s.h.gun
  if (gun.parent !== s.h.slot) {
    return
  }
  s.h.holster.add(gun)
  gun.position.set(0, 0, 0)
  gun.quaternion.identity()
  s.offP.set(0, 0, 0)
  s.offQ.identity()
}

/** The gun's place in the fist: the hand-off offset, and `turns` of a twirl on the trigger finger. */
export function seatGun(s: HandState, a: GunAnatomy, turns: number): void {
  const gun = s.h.gun
  if (gun.parent !== s.h.slot) {
    return
  }
  // the trigger finger: through the guard, below the cylinder, ahead of the grip
  const c = new Vector3(
    MathUtils.lerp(a.grip.x, a.mouthX, 0.55),
    a.cylinder.cy - a.cylinder.hy * 1.3,
    0,
  )
  const rs = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), turns * Math.PI * 2)
  gun.quaternion.copy(s.offQ).multiply(rs)
  gun.position.copy(c).sub(c.clone().applyQuaternion(rs)).applyQuaternion(s.offQ).add(s.offP)
}

/**
 * The single-gun off hand's wrist target: from the clip's hand (`lp`/`lq`), over to steady the
 * grip as the clip holds it (`sup`), then palm down over the hammer to fan (`fan`, each shot's
 * `slap` sweeps it back). `s` is the gun hand, already posed this frame.
 */
export function offHandTarget(
  s: HandState,
  o: {
    bone: (n: string) => Bone | null
    a: GunAnatomy
    clip: { rp: Vector3; rq: Quaternion; lp: Vector3; lq: Quaternion }
    sup: number
    fan: number
    slap: number
  },
): { p: Vector3; q: Quaternion } {
  const { rp, rq, lp, lq } = o.clip
  // the clip's left hand in the clip's right wrist's frame, carried on his right hand as it is now
  const rinv = rq.clone().invert()
  const relP = lp.clone().sub(rp).applyQuaternion(rinv)
  const relQ = rinv.multiply(lq)
  const np = new Vector3()
  const nq = new Quaternion()
  worldOf(s.wrist, np, nq)
  const p = lp.clone().lerp(relP.applyQuaternion(nq).add(np), o.sup)
  const q = lq.clone().slerp(nq.clone().multiply(relQ), o.sup)
  if (o.fan <= 0) {
    return { p, q }
  }
  const sw = s.wrist.getWorldScale(new Vector3()).x
  const g: GunPose = gunInHand({ wp: np, wq: nq, sw, slot: s.h.slot, a: o.a }, gunPose())
  const fq = fanWrist(o.bone, 'L', g, new Quaternion())
  if (fq) {
    // over the hammer, a palm's breadth up and to his left
    const a = o.a
    const hammer = new Vector3(a.rearX, a.cylinder.cy + a.cylinder.hy, 0)
      .sub(a.grip)
      .applyQuaternion(g.q)
      .add(g.p)
    hammer
      .addScaledVector(new Vector3(0, 1, 0).applyQuaternion(g.q), 0.06 - 0.03 * o.slap)
      .addScaledVector(new Vector3(0, 0, -1).applyQuaternion(g.q), 0.07)
      .addScaledVector(new Vector3(-1, 0, 0).applyQuaternion(g.q), 0.02 + 0.05 * o.slap)
    p.lerp(hammer, o.fan)
    q.slerp(fq, o.fan)
  }
  return { p, q }
}
