/**
 * Long guns (the Frontier rifle and coach gun, the rooftop rifleman's rifle) held in both hands.
 *
 * The clips have no long-gun pose, so the gun is placed on his body and his arms are solved to it
 * every frame (two-bone IK), the way a real shooter holds one:
 * - the butt in the pocket of his right shoulder (measured on his chest), riding his chest bone,
 *   the barrel down range when he aims and pitched down at the low ready when he carries it;
 * - his right hand on the wrist of the stock, held the way his hand holds the revolver
 *   (scene/holster.ts `handGrip`);
 * - his left hand under the fore-end, as far forward as his arm reaches, cupped the way the
 *   aiming clip cups it.
 *
 * Every point on the gun is measured from its geometry (`longAnatomy`), barrel along +X, unless
 * the gun's builder carries them (`userData.longAnatomy`: the Winchester, the coach gun).
 */
import { type Bone, type Group, Matrix4, type Object3D, Quaternion, Vector3 } from 'three'
import { type Body, onBones } from './fit.ts'
import { type GunAnatomy, gunPointsOf, handGrip } from './holster.ts'

/** Landmarks of a long gun in its own frame (barrel along +X, top +Y). */
export interface LongAnatomy {
  muzzle: Vector3
  /** The middle of the butt plate. */
  butt: Vector3
  /** The wrist of the stock, where the strong hand closes. */
  wrist: Vector3
  /** Under the fore-end, where the support hand cups it. */
  fore: Vector3
  /** The rear sight's notch and the front sight's top: the sight line (when the builder knows). */
  rear?: Vector3
  front?: Vector3
  /** A lever gun: the middle of the lever's hand loop, and its pivot (for a lever throw). */
  lever?: Vector3
  leverPivot?: Vector3
  /** A break-open gun: the hinge pin its barrels drop on. */
  hinge?: Vector3
}

/** The landmarks a gun's builder carried on it, in the gun's frame (null: measure them). */
function carried(gun: Object3D): LongAnatomy | null {
  let src: Object3D | null = null
  gun.traverse((n) => {
    if (!src && n.userData.longAnatomy) {
      src = n
    }
  })
  const o = src as Object3D | null
  if (!o) {
    return null
  }
  const a = o.userData.longAnatomy as LongAnatomy
  gun.updateMatrixWorld(true)
  const to = gun.matrixWorld.clone().invert().multiply(o.matrixWorld)
  const map = (v: Vector3 | undefined) => v?.clone().applyMatrix4(to)
  const out: LongAnatomy = {
    muzzle: a.muzzle.clone().applyMatrix4(to),
    butt: a.butt.clone().applyMatrix4(to),
    wrist: a.wrist.clone().applyMatrix4(to),
    fore: a.fore.clone().applyMatrix4(to),
  }
  for (const k of ['rear', 'front', 'lever', 'leverPivot', 'hinge'] as const) {
    const v = map(a[k])
    if (v) {
      out[k] = v
    }
  }
  return out
}

/**
 * Measure a long gun: the muzzle at its front on the bore, the butt at its back, the wrist where
 * the stock is slimmest behind the action, the fore-end just ahead of the action (where the
 * section first slims to the barrel's), under it.
 */
export function longAnatomy(gun: Object3D): LongAnatomy {
  const known = carried(gun)
  if (known) {
    return known
  }
  const pts = gunPointsOf(gun)
  let x0 = 1e9
  let x1 = -1e9
  for (const p of pts) {
    x0 = Math.min(x0, p.x)
    x1 = Math.max(x1, p.x)
  }
  const len = x1 - x0
  const n = 40
  const lo = new Array<number>(n).fill(1e9)
  const hi = new Array<number>(n).fill(-1e9)
  for (const p of pts) {
    const i = Math.min(n - 1, Math.floor(((p.x - x0) / len) * n))
    lo[i] = Math.min(lo[i] ?? 1e9, p.y)
    hi[i] = Math.max(hi[i] ?? -1e9, p.y)
  }
  const xAt = (i: number) => x0 + ((i + 0.5) / n) * len
  const tall = (i: number) => ((hi[i] ?? 0) > (lo[i] ?? 0) ? (hi[i] ?? 0) - (lo[i] ?? 0) : 0)
  const mid = (i: number) => ((hi[i] ?? 0) + (lo[i] ?? 0)) / 2
  // the bore: the middle of the front tenth
  const front = pts.filter((p) => p.x > x1 - len / 10).map((p) => p.y)
  front.sort((a, b) => a - b)
  const bore = front[Math.floor(front.length / 2)] ?? 0
  // the wrist: slimmest section between 15% and 45% of the length from the butt
  let wi = Math.floor(n * 0.3)
  for (let i = Math.floor(n * 0.15); i <= Math.floor(n * 0.45); i++) {
    if (tall(i) > 0 && tall(i) < tall(wi)) {
      wi = i
    }
  }
  // the barrel's girth (front quarter), then back from the muzzle to where the action starts
  let barrel = 0
  for (let i = Math.floor(n * 0.75); i < n; i++) {
    barrel = Math.max(barrel, tall(i))
  }
  let fi = n - 1
  while (fi > wi + 2 && tall(fi - 1) <= barrel * 1.6) {
    fi--
  }
  // a hand's width ahead of the action
  let foreI = Math.min(n - 1, fi + 2)
  while (foreI < n - 1 && tall(foreI) <= 0) {
    foreI++
  }
  return {
    muzzle: new Vector3(x1, bore, 0),
    butt: new Vector3(x0, mid(0), 0),
    wrist: new Vector3(xAt(wi), mid(wi), 0),
    fore: new Vector3(xAt(foreI), (lo[foreI] ?? bore) - 0.012, 0),
  }
}

const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpC = new Vector3()
const tmpQ = new Quaternion()
const tmpQ2 = new Quaternion()

/** Set a bone's world rotation (its parent's world matrix must be current). */
function setWorldQuat(b: Bone, q: Quaternion): void {
  const parentQ = b.parent ? b.parent.getWorldQuaternion(tmpQ2) : tmpQ2.identity()
  b.quaternion.copy(parentQ.invert().multiply(q))
  b.updateMatrixWorld(true)
}

/**
 * Two-bone IK: swing `upper` and `lower` so `end` lands on `target` (or as close as the arm
 * reaches), the elbow bent toward `pole`; then turn `end` to `quat` in world space.
 */
export function solveArm(
  chain: { upper: Bone; lower: Bone; end: Bone },
  target: Vector3,
  quat: Quaternion,
  pole: Vector3,
): void {
  const { upper, lower, end } = chain
  const s = upper.getWorldPosition(new Vector3())
  const e = lower.getWorldPosition(new Vector3())
  const w = end.getWorldPosition(new Vector3())
  const a = s.distanceTo(e)
  const b = e.distanceTo(w)
  const toT = target.clone().sub(s)
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, toT.length()))
  const u = toT.normalize()
  const p = pole.clone().sub(s)
  p.addScaledVector(u, -p.dot(u))
  if (p.lengthSq() < 1e-8) {
    p.copy(e).sub(s).addScaledVector(u, -e.clone().sub(s).dot(u))
  }
  p.normalize()
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)))
  const elbow = s
    .clone()
    .addScaledVector(u, a * cosA)
    .addScaledVector(p, a * Math.sqrt(1 - cosA * cosA))
  // swing the upper arm onto the new elbow
  const swing1 = tmpQ.setFromUnitVectors(
    tmpA.copy(e).sub(s).normalize(),
    tmpB.copy(elbow).sub(s).normalize(),
  )
  setWorldQuat(upper, swing1.clone().multiply(upper.getWorldQuaternion(new Quaternion())))
  // swing the forearm onto the target
  const e2 = lower.getWorldPosition(new Vector3())
  const w2 = end.getWorldPosition(new Vector3())
  const reachT = s.clone().addScaledVector(u, d)
  const swing2 = tmpQ.setFromUnitVectors(
    tmpA.copy(w2).sub(e2).normalize(),
    tmpC.copy(reachT).sub(e2).normalize(),
  )
  setWorldQuat(lower, swing2.clone().multiply(lower.getWorldQuaternion(new Quaternion())))
  setWorldQuat(end, quat)
}

/** A long gun on his body: where it rides, and where each hand holds it. */
export interface LongHold {
  obj: Object3D
  a: LongAnatomy
  /** Rides his chest bone; its origin is the butt, its +X down range in the aiming pose. */
  slot: Group
  /** Each wrist in the gun's frame. */
  right: Matrix4
  left: Matrix4 | null
}

/**
 * Fit a long gun to him in his aiming pose (the clip must be posing him, world matrices current).
 * `pocket` is the hollow of his right shoulder in world space; `rootQ` his facing.
 */
export function fitLong(
  obj: Object3D,
  o: {
    bone: (n: string) => Bone | null
    chest: Bone
    pocket: Vector3
    rootQ: Quaternion
    slotOn: (bone: Bone, p: Vector3, q: Quaternion) => Group
  },
): LongHold | null {
  const a = longAnatomy(obj)
  const wristR = o.bone('WristR')
  const wristL = o.bone('WristL')
  const shoulderL = o.bone('UpperArmL')
  if (!(wristR && wristL && shoulderL)) {
    return null
  }
  // how his right hand holds a grip, from the revolver fit: a stand-in with the stock's wrist as its grip
  const stand: GunAnatomy = {
    muzzle: a.muzzle,
    grip: a.wrist,
    rearX: a.butt.x,
    mouthX: a.wrist.x,
    cylinder: { cy: 0, hy: 0, hz: 0 },
    barrel: { cy: 0, hy: 0, hz: 0 },
  }
  const r = handGrip(o.bone, 'R', stand)
  if (!r) {
    return null
  }
  const gunAim = new Matrix4().compose(r.pos, r.quat, new Vector3(1, 1, 1))
  const wristM = (b: Bone) => {
    const p = b.getWorldPosition(new Vector3())
    const q = b.getWorldQuaternion(new Quaternion())
    return new Matrix4().compose(p, q, new Vector3(1, 1, 1))
  }
  const right = gunAim.clone().invert().multiply(wristM(wristR))
  // the left hand: its cupped palm under the fore-end, kept as the clip cups it
  const palmL = handGrip(o.bone, 'L', stand)
  let left: Matrix4 | null = null
  if (palmL) {
    const leftInGun = gunAim.clone().invert().multiply(wristM(wristL))
    // where the left fist sits now, in the gun's frame (handGrip put the stand-in's grip there)
    const fist = a.wrist
      .clone()
      .applyQuaternion(palmL.quat)
      .add(palmL.pos)
      .applyMatrix4(gunAim.clone().invert())
    const shift = a.fore.clone().sub(fist)
    left = new Matrix4().makeTranslation(shift.x, shift.y, shift.z).multiply(leftInGun)
  }
  // the butt in the shoulder pocket, the barrel down range (his facing), level
  const fwd = new Vector3(0, 0, 1).applyQuaternion(o.rootQ)
  const up = new Vector3(0, 1, 0)
  const side = new Vector3().crossVectors(fwd, up)
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(fwd, up, side))
  const slot = o.slotOn(o.chest, o.pocket, q)
  slot.add(obj)
  obj.position.copy(a.butt).negate()
  return { obj, a, slot, right, left }
}

/**
 * Pose a held long gun and solve his arms to it. `carry` 0 = shouldered and aimed, 1 = the low
 * ready (muzzle pitched down); `kick` lifts the muzzle on a shot.
 */
export function poseLong(
  h: LongHold,
  o: {
    bone: (n: string) => Bone | null
    carry: number
    kick: number
    rootQ: Quaternion
  },
): void {
  const pitch = -0.5 * o.carry + 0.18 * o.kick
  h.obj.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), pitch)
  h.obj.position.copy(h.a.butt).negate().applyQuaternion(h.obj.quaternion)
  h.obj.position.x -= 0.03 * o.kick
  h.obj.updateWorldMatrix(true, false)
  const gun = h.obj.matrixWorld.clone()
  // undo the slot's bone scale: the hand targets are rigid transforms
  const gp = new Vector3()
  const gq = new Quaternion()
  gun.decompose(gp, gq, new Vector3())
  const g = new Matrix4().compose(gp, gq, new Vector3(1, 1, 1))
  const down = new Vector3(0, -1, 0)
  const fwd = new Vector3(0, 0, 1).applyQuaternion(o.rootQ)
  for (const [k, rel, sideSign] of [
    ['R', h.right, -1],
    ['L', h.left, 1],
  ] as const) {
    const upper = o.bone(`UpperArm${k}`)
    const lower = o.bone(`LowerArm${k}`)
    const end = o.bone(`Wrist${k}`)
    if (!(rel && upper && lower && end)) {
      continue
    }
    const t = g.clone().multiply(rel)
    const tp = new Vector3()
    const tq = new Quaternion()
    t.decompose(tp, tq, new Vector3())
    // elbows down and out, a little back
    const outward = new Vector3(sideSign, 0, 0).applyQuaternion(o.rootQ)
    const pole = upper
      .getWorldPosition(new Vector3())
      .addScaledVector(down, 0.4)
      .addScaledVector(outward, 0.25)
      .addScaledVector(fwd, -0.1)
    solveArm({ upper, lower, end }, tp, tq, pole)
  }
}

/**
 * The hollow of his right shoulder, where a butt plate sits: a third of the way from his shoulder
 * joint toward his neck, a little below the joint, on the front of his chest (measured on his
 * surface in the dressing pose; world space).
 */
export function shoulderPocket(body: Body, bone: (n: string) => Bone | null): Vector3 | null {
  const s = bone('UpperArmR')?.getWorldPosition(new Vector3())
  const n = bone('Neck')?.getWorldPosition(new Vector3())
  if (!(s && n)) {
    return null
  }
  const x = s.x + (n.x - s.x) / 3
  const y = s.y - (n.y - s.y) / 3
  let z = Number.NEGATIVE_INFINITY
  for (const p of onBones(body, ['Chest', 'Torso', 'ShoulderR'])) {
    if (Math.abs(p.p.x - x) < 0.03 && Math.abs(p.p.y - y) < 0.03) {
      z = Math.max(z, p.p.z)
    }
  }
  return new Vector3(x, y, Number.isFinite(z) ? z : s.z + 0.08)
}
