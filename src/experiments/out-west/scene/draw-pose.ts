/**
 * The geometry of a quick-draw (scene/draw.ts drives it): where the revolver is at each key of the
 * draw, how his wrist must sit to hold it there, and the bone nudges of the turn.
 *
 * A gun pose is the revolver's grip point and its rotation in world space (its own frame: barrel
 * +X, top +Y, +Z to the shooter's right when he aims). Every key is measured off his own body,
 * live, every frame: the holster rides his thigh, the aim comes from the clip, so it fits every
 * build and every gun (the Buntline's longer barrel takes a longer pull).
 */
import { type Bone, Matrix4, type Object3D, Quaternion, Vector3 } from 'three'
import type { GunAnatomy } from './holster.ts'

export interface GunPose {
  /** The middle of the grip, world. */
  p: Vector3
  /** The revolver's world rotation. */
  q: Quaternion
}

export const gunPose = (): GunPose => ({ p: new Vector3(), q: new Quaternion() })

export function copyPose(to: GunPose, from: GunPose): GunPose {
  to.p.copy(from.p)
  to.q.copy(from.q)
  return to
}

const tv = new Vector3()
const tv2 = new Vector3()
const tq = new Quaternion()
const tm = new Matrix4()
const X = new Vector3(1, 0, 0)
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)

/** The gun riding in the hand slot of a wrist at `wp`/`wq` (world scale `sw`). */
export function gunInHand(
  o: { wp: Vector3; wq: Quaternion; sw: number; slot: Object3D; a: GunAnatomy },
  out: GunPose,
): GunPose {
  out.q.copy(o.wq).multiply(o.slot.quaternion)
  out.p
    .copy(o.slot.position)
    .multiplyScalar(o.sw)
    .applyQuaternion(o.wq)
    .add(o.wp)
    .add(tv.copy(o.a.grip).applyQuaternion(out.q))
  return out
}

/** The wrist (world position and rotation) that holds the gun at `g` in its slot. */
export function wristFor(
  g: GunPose,
  o: { sw: number; slot: Object3D; a: GunAnatomy },
  outP: Vector3,
  outQ: Quaternion,
): void {
  outQ.copy(g.q).multiply(tq.copy(o.slot.quaternion).invert())
  outP
    .copy(g.p)
    .sub(tv.copy(o.a.grip).applyQuaternion(g.q))
    .sub(tv2.copy(o.slot.position).multiplyScalar(o.sw).applyQuaternion(outQ))
}

/** The gun as it sits in its holster (the slot's world frame; the gun's own offset ignored). */
export function holstered(holster: Object3D, a: GunAnatomy, out: GunPose): GunPose {
  holster.updateWorldMatrix(true, false)
  holster.matrixWorld.decompose(out.p, out.q, tv)
  out.p.add(tv.copy(a.grip).applyQuaternion(out.q))
  return out
}

/** Clear of the leather: the holstered pose lifted back along its barrel by the barrel's length. */
export function pulled(g1: GunPose, a: GunAnatomy, out: GunPose): GunPose {
  const clear = a.muzzle.x - a.mouthX + 0.02
  out.q.copy(g1.q)
  out.p.copy(g1.p).addScaledVector(tv.copy(X).applyQuaternion(g1.q), -clear)
  return out
}

/** A level gun at `p`, its barrel along `dir` (top up), canted `cant` about the barrel. */
export function levelPose(p: Vector3, dir: Vector3, cant: number, out: GunPose): GunPose {
  const x = tv.copy(dir).normalize()
  const y = tv2.copy(Y).addScaledVector(x, -Y.dot(x)).normalize()
  const z = new Vector3().crossVectors(x, y)
  out.q.setFromRotationMatrix(tm.makeBasis(x, y, z))
  if (cant !== 0) {
    out.q.multiply(tq.setFromAxisAngle(X, cant))
  }
  out.p.copy(p)
  return out
}

/** Turn a gun pose by `q` about `pivot` (world). */
export function swingAbout(g: GunPose, q: Quaternion, pivot: Vector3): void {
  g.p.sub(pivot).applyQuaternion(q).add(pivot)
  g.q.premultiply(q)
}

/** The muzzle of a gun pose. */
export function muzzleOf(g: GunPose, a: GunAnatomy, out: Vector3): Vector3 {
  return out.copy(a.muzzle).sub(a.grip).applyQuaternion(g.q).add(g.p)
}

/**
 * The rotation that turns this gun's barrel onto `target` (from its muzzle), at most `max` radians.
 */
export function aimCorrection(
  g: GunPose,
  a: GunAnatomy,
  { target, max }: { target: Vector3; max: number },
  out: Quaternion,
): Quaternion {
  const m = muzzleOf(g, a, new Vector3())
  const barrel = tv.copy(X).applyQuaternion(g.q)
  const want = tv2.copy(target).sub(m).normalize()
  out.setFromUnitVectors(barrel, want)
  const ang = 2 * Math.acos(Math.min(1, Math.abs(out.w)))
  if (ang > max) {
    out.slerp(tq.identity(), 1 - max / ang)
  }
  return out
}

/** Pitch a gun pose about its own side axis at the grip (positive lifts the muzzle). */
export function pitch(g: GunPose, angle: number): void {
  g.q.multiply(tq.setFromAxisAngle(Z, angle))
}

/** Catmull-Rom through four poses' grip points at s 0..1 (uniform); rotations slerp per span. */
export function alongKeys(keys: readonly GunPose[], s: number, out: GunPose): GunPose {
  const n = keys.length - 1
  const f = Math.min(n - 1e-6, Math.max(0, s * n))
  const i = Math.floor(f)
  const t = f - i
  const k = (j: number): Vector3 => {
    if (j < 0) {
      return new Vector3()
        .copy(keys[0]?.p ?? tv)
        .multiplyScalar(2)
        .sub(keys[1]?.p ?? tv)
    }
    if (j > n) {
      return new Vector3()
        .copy(keys[n]?.p ?? tv)
        .multiplyScalar(2)
        .sub(keys[n - 1]?.p ?? tv)
    }
    return keys[j]?.p ?? tv
  }
  const p0 = k(i - 1)
  const p1 = k(i)
  const p2 = k(i + 1)
  const p3 = k(i + 2)
  const t2 = t * t
  const t3 = t2 * t
  out.p.set(0, 0, 0)
  out.p.addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
  out.p.addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
  out.p.addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
  out.p.addScaledVector(p3, 0.5 * t3 - 0.5 * t2)
  out.q.copy(keys[i]?.q ?? tq).slerp(keys[i + 1]?.q ?? tq, t)
  return out
}

/** Rotate a bone by a world-space rotation (its parent's world matrix current); updates it. */
export function rotateWorld(b: Bone, q: Quaternion): void {
  const parent = b.parent
  if (!parent) {
    return
  }
  const pq = parent.getWorldQuaternion(new Quaternion())
  b.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq))
  b.updateMatrixWorld(true)
}

/** Move a bone by a world-space offset (its parent's world matrix current); updates it. */
export function moveWorld(b: Bone, d: Vector3): void {
  const parent = b.parent
  if (!parent) {
    return
  }
  const w = b.getWorldPosition(new Vector3()).add(d)
  b.position.copy(parent.worldToLocal(w))
  b.updateMatrixWorld(true)
}

/** A bone's world position and rotation. */
export function worldOf(b: Object3D, p: Vector3, q: Quaternion): void {
  b.updateWorldMatrix(true, false)
  b.matrixWorld.decompose(p, q, tv)
}

/**
 * The wrist rotation that lays a hand palm-down across a gun (the fan): fingers along the gun's
 * side axis (across the top, toward the gun hand), thumb back toward the shooter.
 */
export function fanWrist(
  bone: (n: string) => Bone | null,
  side: 'R' | 'L',
  g: GunPose,
  out: Quaternion,
): Quaternion | null {
  const w = bone(`Wrist${side}`)
  const m = bone(`Middle1${side}`)
  const i = bone(`Index1${side}`)
  const k = bone(`Pinky1${side}`)
  if (!(w && m && i && k)) {
    return null
  }
  const wq = w.getWorldQuaternion(new Quaternion())
  const wp = w.getWorldPosition(new Vector3())
  const inv = wq.clone().invert()
  // the hand's own axes, in the wrist's frame
  const f = m.getWorldPosition(new Vector3()).sub(wp).applyQuaternion(inv).normalize()
  const t = i
    .getWorldPosition(new Vector3())
    .sub(k.getWorldPosition(new Vector3()))
    .applyQuaternion(inv)
  t.addScaledVector(f, -t.dot(f)).normalize()
  const local = new Matrix4().makeBasis(f, t, new Vector3().crossVectors(f, t))
  // where they should point
  const F = new Vector3(0, 0, side === 'L' ? 1 : -1).applyQuaternion(g.q)
  const T = new Vector3(-1, 0, 0).applyQuaternion(g.q)
  T.addScaledVector(F, -T.dot(F)).normalize()
  const world = new Matrix4().makeBasis(F, T, new Vector3().crossVectors(F, T))
  out.setFromRotationMatrix(world.multiply(local.invert()))
  return out
}
