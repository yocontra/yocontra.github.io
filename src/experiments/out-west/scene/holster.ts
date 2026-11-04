// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * Where the gunbelt, the holster and the revolver in it go on the man wearing them, and the
 * revolver's seat in his hand (the leather itself is built in scene/gunbelt.ts).
 *
 * Nothing here is an offset tuned to one body. Each base and build is measured the way his hat
 * is (scene/hats.ts): on his skinned surface in the pose he is dressed in (idle, frame 0, root
 * space: metres, Y up, facing +Z, his right hand at -X), and the revolver is measured on its own
 * geometry (`gunAnatomy`):
 * - the belt rides on his hips at his hip joints, over whatever he wears there, and slopes down
 *   to the holster on the gun side;
 * - the holster hangs from it on the outside of the thigh: the butt at his relaxed wrist (so his
 *   hand finds it), the barrel down the thigh with a slight forward rake, the leather flush on
 *   his trousers (or his coat), the grip out and back;
 * - in the hand, the grip sits in the fist his fingers make in the aiming pose and the barrel runs
 *   down his forearm and trigger finger.
 */
import { type Bone, Matrix4, type Mesh, type Object3D, Quaternion, Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, onBones } from './fit.ts'

// ---------------------------------------------------------------- the revolver, measured

/** Landmarks of a revolver in its own frame (barrel along +X, top +Y, the grip at -X, -Y). */
export interface GunAnatomy {
  /** The muzzle: the front of the barrel, on the bore. */
  muzzle: Vector3
  /** The middle of the grip (where the fist closes). */
  grip: Vector3
  /** The rear-most point of the gun (the butt / hammer end): it rides at the top of the holster. */
  rearX: number
  /** Where the holster's mouth closes: the cylinder (the widest part), so it sits at the mouth. */
  mouthX: number
  /** The cylinder's section (centre height, half height, half thickness): the holster's mouth. */
  cylinder: Section
  /** The barrel's section (sights and ejector housing included): the holster's toe. */
  barrel: Section
  /** The sight line, when the gun carries its sights: the rear notch's floor and the blade's top. */
  rear?: Vector3
  front?: Vector3
}

/** Every vertex of a gun in its own frame (its own transform excluded). */
export function gunPointsOf(gun: Object3D): Vector3[] {
  gun.updateMatrixWorld(true)
  const inv = gun.matrixWorld.clone().invert()
  const pts: Vector3[] = []
  gun.traverse((o) => {
    const m = o as Mesh
    // a far level of detail lies inside the near one: measure the near one only
    if (!m.isMesh || m.userData.lod === true) {
      return
    }
    const to = inv.clone().multiply(m.matrixWorld)
    const pos = m.geometry.getAttribute('position')
    for (let k = 0; k < pos.count; k++) {
      pts.push(new Vector3().fromBufferAttribute(pos, k).applyMatrix4(to))
    }
  })
  return pts
}

export interface Section {
  cy: number
  hy: number
  hz: number
}

function section(pts: readonly Vector3[]): Section {
  let lo = 1e9
  let hi = -1e9
  let hz = 0
  for (const p of pts) {
    lo = Math.min(lo, p.y)
    hi = Math.max(hi, p.y)
    hz = Math.max(hz, Math.abs(p.z))
  }
  return lo > hi ? { cy: 0, hy: 0.01, hz: 0.01 } : { cy: (lo + hi) / 2, hy: (hi - lo) / 2, hz }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/**
 * Measure a revolver (any mesh, any length: the Buntline's stretched barrel is measured as it is).
 * The barrel is its front third, the grip its rear-most fifth below mid-height, the cylinder
 * where it is thickest.
 */
export function gunAnatomy(gun: Object3D): GunAnatomy {
  // a gun built in code carries its own landmarks (scene/revolver.ts); a clone's userData has
  // been through JSON, so its points are plain {x, y, z}
  const own = gun.userData.gunAnatomy as GunAnatomy | undefined
  if (own) {
    const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z)
    return {
      ...own,
      muzzle: v(own.muzzle),
      grip: v(own.grip),
      cylinder: { ...own.cylinder },
      barrel: { ...own.barrel },
      ...(own.rear ? { rear: v(own.rear) } : {}),
      ...(own.front ? { front: v(own.front) } : {}),
    }
  }
  const pts = gunPointsOf(gun)
  const b = new Vector3(1e9, 1e9, 1e9)
  const t = new Vector3(-1e9, -1e9, -1e9)
  for (const p of pts) {
    b.min(p)
    t.max(p)
  }
  const len = t.x - b.x
  const tall = t.y - b.y
  const front = pts.filter((p) => p.x > t.x - len / 3)
  const bore = median(front.map((p) => p.y))
  const gripPts = pts.filter((p) => p.x < b.x + len / 5 && p.y < b.y + tall / 2)
  const grip = gripPts
    .reduce((acc, p) => acc.add(p), new Vector3())
    .multiplyScalar(1 / Math.max(1, gripPts.length))
  const zMax = Math.max(Math.abs(b.z), Math.abs(t.z))
  const wide = pts.filter((p) => Math.abs(p.z) > zMax * 0.8)
  const cyl0 = Math.min(...wide.map((p) => p.x))
  const cyl1 = Math.max(...wide.map((p) => p.x))
  const cylinder = section(wide)
  const cylLo = cylinder.cy - cylinder.hy
  // the trigger guard hangs below the cylinder in front of the grip: the mouth closes just ahead of it
  const guard = pts.filter((p) => p.y < cylLo && p.x > grip.x + len / 10 && p.x < cyl1)
  const guardFront = guard.length > 0 ? Math.max(...guard.map((p) => p.x)) : cyl0
  const mouthX = Math.min(cyl1, Math.max((cyl0 + cyl1) / 2, guardFront + 0.004))
  return {
    muzzle: new Vector3(t.x, bore, 0),
    grip: new Vector3(grip.x, grip.y, 0),
    rearX: b.x,
    mouthX,
    cylinder,
    barrel: section(front),
  }
}

// ---------------------------------------------------------------- the seat in the hand

const FINGERS = ['Middle', 'Ring', 'Pinky'] as const

/** Centre of the circle best through `pts` (projected on the plane through `o` normal to `n`). */
function circleCentre(pts: readonly Vector3[], o: Vector3, n: Vector3): Vector3 {
  // a basis on the plane
  const e1 = new Vector3(1, 0, 0)
  if (Math.abs(e1.dot(n)) > 0.9) {
    e1.set(0, 0, 1)
  }
  e1.addScaledVector(n, -e1.dot(n)).normalize()
  const e2 = new Vector3().crossVectors(n, e1)
  // Kåsa fit: x² + y² + D x + E y + F = 0, least squares (3×3 normal equations)
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const B = [0, 0, 0]
  for (const p of pts) {
    const d = p.clone().sub(o)
    const x = d.dot(e1)
    const y = d.dot(e2)
    const row = [x, y, 1]
    const rhs = -(x * x + y * y)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        A[i * 3 + j] = (A[i * 3 + j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0)
      }
      B[i] = (B[i] ?? 0) + (row[i] ?? 0) * rhs
    }
  }
  const m = new Matrix4().set(
    A[0] ?? 0,
    A[1] ?? 0,
    A[2] ?? 0,
    0,
    A[3] ?? 0,
    A[4] ?? 0,
    A[5] ?? 0,
    0,
    A[6] ?? 0,
    A[7] ?? 0,
    A[8] ?? 0,
    0,
    0,
    0,
    0,
    1,
  )
  if (Math.abs(m.determinant()) < 1e-14) {
    return pts.reduce((acc, p) => acc.add(p), new Vector3()).multiplyScalar(1 / pts.length)
  }
  const sol = new Vector3(B[0], B[1], B[2]).applyMatrix4(m.invert())
  return o
    .clone()
    .addScaledVector(e1, -sol.x / 2)
    .addScaledVector(e2, -sol.y / 2)
}

/**
 * Where the revolver sits in a hand posed to aim (world space): its grip in the fist the middle,
 * ring and little fingers close around, its top toward the index knuckle, its barrel down the
 * forearm and the trigger finger. Null when the hand has no finger bones.
 */
export function handGrip(
  bone: (name: string) => Bone | null,
  side: 'R' | 'L',
  a: GunAnatomy,
  /** Hold it turned this way instead (the off hand's gun parallel to the strong hand's). */
  like?: Quaternion,
): { pos: Vector3; quat: Quaternion } | null {
  const at = (n: string): Vector3 | null =>
    bone(`${n}${side}`)?.getWorldPosition(new Vector3()) ?? null
  const fore = at('LowerArm')
  const wrist = at('Wrist')
  const i1 = at('Index1')
  const i2 = at('Index2')
  const p1 = at('Pinky1')
  if (!(fore && wrist && i1 && i2 && p1)) {
    return null
  }
  // up the grip: from the little finger's knuckle to the index finger's
  const up = i1.clone().sub(p1).normalize()
  // the barrel: the forearm and the trigger finger, square to the grip
  const barrel = wrist.clone().sub(fore).normalize().add(i2.clone().sub(i1).normalize())
  barrel.addScaledVector(up, -barrel.dot(up)).normalize()
  const top = up.clone().addScaledVector(barrel, -up.dot(barrel)).normalize()
  const side3 = new Vector3().crossVectors(barrel, top)
  const quat =
    like?.clone() ??
    new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(barrel, top, side3))
  // the fist: centre of each wrapping finger's curl, averaged
  const centres: Vector3[] = []
  for (const f of FINGERS) {
    const js = [1, 2, 3, 4].map((k) => at(`${f}${k}`)).filter((p): p is Vector3 => p !== null)
    if (js.length >= 3 && js[0]) {
      centres.push(circleCentre(js, js[0], up))
    }
  }
  if (centres.length === 0) {
    return null
  }
  const fist = centres
    .reduce((acc, p) => acc.add(p), new Vector3())
    .multiplyScalar(1 / centres.length)
  // the grip's middle in the fist
  const pos = fist.sub(a.grip.clone().applyQuaternion(quat))
  return { pos, quat }
}

// ---------------------------------------------------------------- the belt and holster on him

/** Forward rake of the holster off his thigh line, radians (the muzzle a touch forward). */
const RAKE = 0.14
/** Leather thickness, and the room left between the gun and the leather. */
export const LEATHER = 0.005
export const EASE = 0.004
/** Gunbelt width (scaled with his build) and thickness. */
export const BELT_W = 0.045
export const BELT_T = 0.008
/** How far the belt drops on a gun side, in thigh lengths. */
const SAG = 0.06

/** Where one holster hangs, all in root space. */
export interface HolsterFit {
  side: 1 | -1
  /** The gun's frame in the holster: origin and rotation (its +X down the holster). */
  pos: Vector3
  quat: Quaternion
  /** Heights where the belt crosses this side, and the holster's mouth. */
  beltY: number
  mouthY: number
  /** Outer face of his thigh (or coat) under the drop strap, at the belt and at the mouth. */
  strap: { top: Vector3; bottom: Vector3; out: Vector3 }
}

export interface BeltFit {
  /** Belt height at his front and back (hip joints), and how far it drops on a gun side. */
  y: number
  sag: number
  holsters: HolsterFit[]
}

/** His hips and thighs plus whatever he wears over them: the surfaces leather must sit on. */
export function hipSurface(body: Body, clothes: readonly Piece[]): Vector3[] {
  const pts = onBones(body, ['Hips', 'Abdomen', 'UpperLegL', 'UpperLegR']).map((s) => s.p)
  const v = new Vector3()
  for (const c of clothes) {
    const pos = c.geo.getAttribute('position')
    for (let k = 0; k < pos.count; k++) {
      pts.push(v.fromBufferAttribute(pos, k).clone())
    }
  }
  return pts
}

/**
 * Outside of the thigh at height `y` on `side` (1 = his right, -X), in "outward" metres
 * (larger = further out), within `dz` of `z`; and the thigh's front-to-back middle there.
 */
function thighAt(
  pts: readonly Vector3[],
  o: { side: 1 | -1; y: number; z: number; dz: number; cx: number },
): { out: number; midZ: number } {
  let out = Number.NEGATIVE_INFINITY
  let z0 = Number.POSITIVE_INFINITY
  let z1 = Number.NEGATIVE_INFINITY
  for (const p of pts) {
    if (Math.abs(p.y - o.y) > 0.025) {
      continue
    }
    const outward = -o.side * (p.x - o.cx)
    if (outward <= 0) {
      continue
    }
    if (Math.abs(p.z - o.z) < o.dz) {
      out = Math.max(out, outward)
    }
    if (outward > 0.03) {
      z0 = Math.min(z0, p.z)
      z1 = Math.max(z1, p.z)
    }
  }
  return {
    out: Number.isFinite(out) ? out : 0.15,
    midZ: Number.isFinite(z0) ? (z0 + z1) / 2 : o.z,
  }
}

/**
 * Fit the gunbelt and a holster on each gun side (1 = right; -1 for a second gun on the left).
 * `bone` reads his bones in the dressing pose; `a` is the revolver he carries.
 */
export function fitBelt(
  body: Body,
  clothes: readonly Piece[],
  bone: (name: string) => Bone | null,
  o: { sides: readonly (1 | -1)[]; a: GunAnatomy; root: Object3D },
): BeltFit | null {
  const inv = o.root.matrixWorld.clone().invert()
  const at = (n: string): Vector3 | null =>
    bone(n)?.getWorldPosition(new Vector3()).applyMatrix4(inv) ?? null
  const hipR = at('UpperLegR')
  const hipL = at('UpperLegL')
  const kneeR = at('LowerLegR')
  const kneeL = at('LowerLegL')
  const hips = at('Hips')
  if (!(hipR && hipL && kneeR && kneeL && hips)) {
    return null
  }
  const pts = hipSurface(body, clothes)
  // his build: thigh length sets every proportion below
  const thigh = (hipR.distanceTo(kneeR) + hipL.distanceTo(kneeL)) / 2
  // the belt rides on the hips just above the hip joints
  const y = (hipR.y + hipL.y) / 2 + thigh * 0.08
  const cx = hips.x
  const holsters: HolsterFit[] = []
  for (const side of o.sides) {
    const hip = side === 1 ? hipR : hipL
    const knee = side === 1 ? kneeR : kneeL
    const wrist = at(side === 1 ? 'WristR' : 'WristL')
    // the butt at his relaxed wrist, never above the belt
    const buttY = Math.min(wrist?.y ?? hip.y - thigh * 0.1, y - thigh * 0.02)
    // down the thigh in its side view, raked forward
    const d = knee.clone().sub(hip)
    const sag = Math.atan2(-d.z, -d.y) - RAKE
    let lean = 0
    let fitPos = new Vector3()
    let quat = new Quaternion()
    let mouthY = buttY
    let toeY = buttY
    let midZ = hip.z
    for (let pass = 0; pass < 3; pass++) {
      // the gun's +X down (leaning out by `lean`, tipped back by `sag`), +Y forward, +Z outward
      const down = new Vector3(-side * Math.sin(lean), -Math.cos(lean), 0)
        .applyAxisAngle(new Vector3(1, 0, 0), sag)
        .normalize()
      const fwd = new Vector3(0, 0, 1).addScaledVector(down, -down.z).normalize()
      // the revolver is symmetric side to side: +Z is outward on his right, inward on his left
      const out = new Vector3().crossVectors(down, fwd)
      quat = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(down, fwd, out))
      const mouth = o.a.cylinder
      const toe = o.a.barrel
      const mouthP = new Vector3(o.a.mouthX, mouth.cy, 0).applyQuaternion(quat)
      const toeP = new Vector3(o.a.muzzle.x, toe.cy, 0).applyQuaternion(quat)
      // the rear of the gun at the butt height
      const rear = new Vector3(o.a.rearX, o.a.grip.y, 0).applyQuaternion(quat)
      const oy = buttY - rear.y
      mouthY = oy + mouthP.y
      toeY = oy + toeP.y
      // flush on the outside of his thigh (or coat) at the mouth and at the toe
      const near = { side, z: midZ, dz: 0.05, cx }
      const m = thighAt(pts, { ...near, y: mouthY })
      const t = thighAt(pts, { ...near, y: (mouthY + toeY) / 2 })
      const b = thighAt(pts, { ...near, y: toeY })
      midZ = m.midZ
      const outM = m.out + LEATHER + mouth.hz + EASE + LEATHER
      // the middle of the leg bulging past the line from mouth to toe pushes both out
      const outT0 = b.out + LEATHER + toe.hz + EASE + LEATHER
      const bulge = Math.max(
        0,
        t.out + LEATHER + (mouth.hz + toe.hz) / 2 + EASE + LEATHER - (outM + outT0) / 2,
      )
      const outT = outT0 + bulge
      lean = Math.max(-0.35, Math.min(0.35, Math.atan2(outT - outM, mouthY - toeY)))
      // the sleeve's centre at the mouth: on the thigh's side line, its middle over the thigh's
      const want = new Vector3(cx - side * (outM + bulge), mouthY, midZ)
      fitPos = want.sub(mouthP).setY(oy)
    }
    const strapOut = thighAt(pts, { side, y: (y + mouthY) / 2, z: midZ, dz: 0.04, cx }).out
    holsters.push({
      side,
      pos: fitPos,
      quat,
      beltY: y - thigh * SAG,
      mouthY,
      strap: {
        top: new Vector3(cx - side * strapOut, y - thigh * SAG, midZ),
        bottom: new Vector3(cx - side * strapOut, mouthY - thigh * 0.04, midZ),
        out: new Vector3(-side, 0, 0),
      },
    })
  }
  return { y, sag: thigh * SAG, holsters }
}
