// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh/isSkinnedMesh flags are typed `true` on the cast type; testing them is the runtime type check
/**
 * The outlaws' wardrobe, fitted to the man wearing it.
 *
 * Every garment is shrink-wrapped around his posed surface (see fit.ts) and
 * returned as a bake Piece, skinned to the bones under it. Nothing here is
 * placed from a bounding box or a guessed offset, so a coat on the king and a
 * coat on the clerk both sit on the hips, and both follow the thighs through
 * the walk.
 */
import {
  type Bone,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Shape,
  ShapeGeometry,
  TubeGeometry,
  Vector3,
} from 'three'
import { meshPieces, onBone, type Piece } from './bake.ts'
import { type Body, bounds, nearestWeights, onBones, shell, type WeightFn } from './fit.ts'
import { FABRIC } from './style.ts'

/**
 * Remove the parts of a base he doesn't wear before he is measured or drawn: the optional
 * beard (tools/build-characters.ts marks it) unless he has one.
 */
export function prune(model: Object3D, o: { beard: boolean }): void {
  const drop: Object3D[] = []
  model.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) {
      return
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (mat?.userData.optional && !(o.beard && mat.name === 'Beard')) {
      drop.push(obj)
    }
  })
  for (const d of drop) {
    d.removeFromParent()
  }
}

/** Landmarks measured on his posed surface (root space). */
export interface Fit {
  readonly body: Body
  readonly bone: (name: string) => Bone | null
  readonly at: (name: string) => Vector3
  readonly head: {
    cx: number
    cz: number
    top: number
    chin: number
    eye: number
    /** Radius of the skull/hair just below the crown. */
    r: number
  }
  readonly neck: { lo: number; hi: number }
}

const HEAD_BONES = ['Head']
const NECK_BONES = ['Neck']
const TORSO_BONES = ['Chest', 'Torso', 'Abdomen', 'Hips', 'Neck', 'ShoulderL', 'ShoulderR']
const LEG_BONES = ['Hips', 'Abdomen', 'UpperLegL', 'UpperLegR', 'LowerLegL', 'LowerLegR']
const ARM_BONES = ['UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR']

export function measure(body: Body, bones: Map<string, Bone>): Fit {
  const bone = (n: string) => bones.get(n) ?? null
  const at = (n: string) => bone(n)?.getWorldPosition(new Vector3()) ?? new Vector3()
  const head = onBones(body, HEAD_BONES)
  const hb = bounds(head)
  const top = hb.max.y
  // Skull centre from the upper head (hair can trail behind; the face sticks out front).
  const upper = head.filter((s) => s.p.y > top - 0.14)
  const ub = bounds(upper.length > 0 ? upper : head)
  const cx = ub.center.x
  const cz = ub.center.z
  const front = head.filter((s) => s.p.z > cz + 0.03)
  const chin = front.length > 0 ? bounds(front).min.y : hb.min.y
  const eyes = head.filter((s) => s.mat === 'Eye')
  const eye =
    eyes.length > 0 ? eyes.reduce((t, s) => t + s.p.y, 0) / eyes.length : chin + 0.55 * (top - chin)
  let r = 0
  for (const s of head) {
    if (s.p.y > top - 0.1 && s.p.y < top - 0.03) {
      r = Math.max(r, Math.hypot(s.p.x - cx, s.p.z - cz))
    }
  }
  const neckS = onBones(body, NECK_BONES)
  const nb = neckS.length > 0 ? bounds(neckS) : null
  const neckBone = at('Neck')
  return {
    body,
    bone,
    at,
    head: { cx, cz, top, chin, eye, r: r || 0.1 },
    neck: { lo: nb ? nb.min.y : neckBone.y - 0.03, hi: nb ? nb.max.y : neckBone.y + 0.06 },
  }
}

const lin = (hex: number) => new Color(hex)
const fabric = (k: keyof typeof FABRIC) => ({
  roughness: FABRIC[k].swatch === 'plain' ? FABRIC[k].roughness : 1,
  rim: FABRIC[k].rim,
  swatch: FABRIC[k].swatch,
})

/** Long duster skirt from the belt to mid-shin, open at the front, following hips and thighs. */
export function coat(f: Fit, color: number): Piece[] {
  const hips = f.at('Hips')
  const knee = f.at('LowerLegL').add(f.at('LowerLegR')).multiplyScalar(0.5)
  const foot = f.at('FootL').add(f.at('FootR')).multiplyScalar(0.5)
  const yTop = hips.y + 0.06
  const yBot = knee.y - 0.55 * (knee.y - foot.y)
  const legs = onBones(f.body, LEG_BONES)
  const gap = 0.8
  const geo = shell({
    samples: legs,
    cx: hips.x,
    cz: hips.z - 0.01,
    yTop,
    yBot,
    arc: Math.PI,
    half: Math.PI - gap / 2,
    rings: 8,
    segs: 22,
    margin: 0.022,
    bulge: (t) => t * t * 0.07,
    hang: true,
    color: lin(color),
  })
  const hipsB = f.bone('Hips')
  const ulR = f.bone('UpperLegR')
  const ulL = f.bone('UpperLegL')
  const weights: WeightFn = (p) => {
    if (!(hipsB && ulR && ulL)) {
      return hipsB ? [[hipsB, 1]] : []
    }
    const t = Math.min(1, Math.max(0, (yTop - p.y) / (yTop - yBot)))
    const wh = 1 - Math.min(0.88, t * 1.6)
    // his right is -X
    const u = Math.min(1, Math.max(0, (-(p.x - hips.x) + 0.08) / 0.16))
    const sR = u * u * (3 - 2 * u)
    return [
      [hipsB, wh],
      [ulR, (1 - wh) * sR],
      [ulL, (1 - wh) * (1 - sR)],
    ]
  }
  return [{ geo, ...fabric('wool'), weights }]
}

const STRIPES: readonly [number, number, number][] = [
  // [top px, height px, colour] on the 64 px tall weave of the original poncho
  [8, 2, 0xe8_d8_b0],
  [12, 2, 0x1a_1a_1a],
  [16, 2, 0xc0_8a_2a],
  [20, 2, 0xe8_d8_b0],
  [40, 3, 0xe8_d8_b0],
  [45, 3, 0x1a_1a_1a],
  [50, 3, 0xc0_8a_2a],
  [55, 3, 0xe8_d8_b0],
]

/** Striped poncho from the neck to the belt, draped over his shoulders and arms. */
export function poncho(f: Fit, color: number): Piece[] {
  const hips = f.at('Hips')
  const yTop = f.neck.lo + 0.4 * (f.neck.hi - f.neck.lo)
  const yBot = hips.y + 0.1
  const wrap = onBones(f.body, [...TORSO_BONES, ...ARM_BONES, 'Neck'])
  // Ring list: an even grid for the fit, plus doubled rings at stripe edges for crisp bands.
  const marks: { t: number; c: number }[] = []
  const base = color
  const stripeAt = (t: number): number => {
    const px = t * 64
    for (const [y, h, c] of STRIPES) {
      if (px >= y && px < y + h) {
        return c
      }
    }
    return base
  }
  const edges = new Set<number>([0, 1])
  for (let i = 1; i < 10; i++) {
    edges.add(i / 10)
  }
  for (const [y, h] of STRIPES) {
    edges.add(y / 64)
    edges.add((y + h) / 64)
  }
  for (const t of [...edges].sort((a, b) => a - b)) {
    marks.push({ t, c: stripeAt(t - 1e-4) })
    marks.push({ t, c: stripeAt(t + 1e-4) })
  }
  const geo = shell({
    samples: wrap,
    cx: f.at('Chest').x,
    cz: f.at('Chest').z,
    yTop,
    yBot,
    ts: marks.map((m) => m.t),
    segs: 24,
    margin: 0.018,
    bulge: (t) => t * 0.03,
    hang: true,
    band: 0.03,
    color: (_t, i) => lin(marks[i]?.c ?? base),
  })
  const from = onBones(f.body, [
    'Neck',
    'Chest',
    'Torso',
    'Abdomen',
    'ShoulderL',
    'ShoulderR',
    'UpperArmL',
    'UpperArmR',
  ])
  return [{ geo, ...fabric('hessian'), weights: nearestWeights(f.body, from) }]
}

/** Neckerchief: a band snug on the neck and a point hanging over the chest. */
export function bandana(f: Fit, color: number): Piece[] {
  // Only the neck itself: the shoulders would turn the band into a shelf. Tied low on the neck,
  // close to it, so it reads as cloth knotted on a collar rather than a block under the jaw.
  const cx = f.at('Neck').x
  const cz = f.at('Neck').z
  const yTop = f.neck.lo + 0.32 * (f.neck.hi - f.neck.lo)
  const yBot = f.neck.lo + 0.02 * (f.neck.hi - f.neck.lo)
  const neck = onBones(f.body, NECK_BONES).filter((s) => s.p.y > yBot - 0.02 && s.p.y < yTop + 0.02)
  // a fold: the cloth darkens toward the knot and the point, as a rolled scarf does
  const fold = (k: number) => (t: number) => lin(color).multiplyScalar(1 - k * t)
  const band = shell({
    samples: neck,
    cx,
    cz,
    yTop,
    yBot,
    rings: 3,
    segs: 18,
    margin: 0.006,
    bulge: (t) => t * 0.004,
    band: 0.012,
    color: fold(0.3),
  })
  const flap = shell({
    samples: onBones(f.body, ['Chest', 'Neck', 'Torso']),
    cx,
    cz,
    yTop: yBot + 0.004,
    yBot: yBot - 0.075,
    arc: 0,
    half: 0.55,
    taper: (t) => Math.max(0.02, 1 - t),
    rings: 4,
    segs: 6,
    margin: 0.012,
    band: 0.02,
    color: fold(0.35),
  })
  const w = nearestWeights(f.body, onBones(f.body, ['Neck', 'Chest']))
  return [
    { geo: band, ...fabric('linen'), weights: w },
    { geo: flap, ...fabric('linen'), weights: w },
  ]
}

/** Bandana pulled up over the nose (the rifleman, the masked outlaws). */
export function mask(f: Fit, color: number): Piece[] {
  const h = f.head
  const yTop = h.eye - 0.48 * (h.eye - h.chin)
  const yBot = f.neck.lo + 0.3 * (f.neck.hi - f.neck.lo)
  // the face and neck only: long hair hanging past the jaw would balloon it
  const face = onBones(f.body, ['Head', 'Neck']).filter((s) => s.mat !== 'Hair')
  const geo = shell({
    samples: face,
    cx: h.cx,
    cz: h.cz,
    yTop,
    yBot,
    arc: 0,
    half: Math.PI,
    rings: 6,
    segs: 22,
    margin: 0.012,
    band: 0.012,
    color: lin(color),
  })
  return [
    {
      geo,
      ...fabric('linen'),
      weights: nearestWeights(f.body, onBones(f.body, ['Head', 'Neck'])),
    },
  ]
}

/** Tin star on his left breast, flush with the shirt. */
export function star(f: Fit, space: Object3D): Piece[] {
  const b = f.bone('Chest')
  if (!b) {
    return []
  }
  const chest = onBones(f.body, ['Chest', 'Torso'])
  const sx = f.at('Chest').x + 0.085
  const sy = f.at('Chest').y + 0.06
  let z = Number.NEGATIVE_INFINITY
  for (const s of chest) {
    if (Math.abs(s.p.x - sx) < 0.03 && Math.abs(s.p.y - sy) < 0.03) {
      z = Math.max(z, s.p.z)
    }
  }
  const sh = new Shape()
  for (let i = 0; i < 12; i++) {
    const r = i % 2 === 0 ? 0.042 : 0.019
    const a = (i / 12) * Math.PI * 2
    if (i === 0) {
      sh.moveTo(Math.sin(a) * r, Math.cos(a) * r)
    } else {
      sh.lineTo(Math.sin(a) * r, Math.cos(a) * r)
    }
  }
  const m = new Mesh(
    new ShapeGeometry(sh),
    new MeshStandardMaterial({ color: 0xe0_c0_60, roughness: 0.3 }),
  )
  m.position.set(sx, sy, (Number.isFinite(z) ? z : f.at('Chest').z + 0.12) + 0.006)
  m.material.userData.rim = 1.6
  m.material.userData.swatch = 'metal'
  space.add(m)
  const out = meshPieces(m, space, onBone(b))
  m.removeFromParent()
  return out
}

/** Two crossed cartridge belts hugging his chest and back, with brass on the front. */
export function bandoliers(f: Fit, space: Object3D): Piece[] {
  const torso = onBones(f.body, TORSO_BONES)
  const hips = f.at('Hips')
  const yHi = f.neck.lo - 0.03
  const yLo = hips.y + 0.04
  const surfaceZ = (x: number, y: number, front: boolean): number => {
    let z = front ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    for (const s of torso) {
      if (Math.abs(s.p.x - x) < 0.035 && Math.abs(s.p.y - y) < 0.035) {
        z = front ? Math.max(z, s.p.z) : Math.min(z, s.p.z)
      }
    }
    return Number.isFinite(z) ? z : hips.z + (front ? 0.1 : -0.1)
  }
  const leather = new MeshStandardMaterial({ color: 0x3a_24_12, roughness: 0.6 })
  leather.userData.rim = FABRIC.leather.rim
  leather.userData.swatch = 'leather'
  const brass = new MeshStandardMaterial({ color: 0xc8_a0_50, roughness: 0.35 })
  brass.userData.rim = 1.5
  brass.userData.swatch = 'metal'
  const g = new Group()
  for (const side of [-1, 1]) {
    const x0 = side * 0.12
    const x1 = -side * 0.15
    const pts: Vector3[] = []
    const n = 9
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const x = x0 + (x1 - x0) * t
      const y = yHi + (yLo - yHi) * t
      pts.push(new Vector3(x, y, surfaceZ(x, y, true) + 0.014 + side * 0.003))
    }
    for (let i = n; i >= 0; i--) {
      const t = i / n
      const x = x0 + (x1 - x0) * t
      const y = yHi + (yLo - yHi) * t
      pts.push(new Vector3(x, y, surfaceZ(x, y, false) - 0.014))
    }
    const curve = new CatmullRomCurve3(pts, true)
    const strap = new Mesh(new TubeGeometry(curve, 48, 0.014, 4, true), leather)
    g.add(strap)
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    for (let i = 2; i <= 7; i++) {
      const t = i / n
      const p = curve.getPointAt(t * 0.5)
      const tan = curve.getTangentAt(t * 0.5)
      const shellM = new Mesh(new CylinderGeometry(0.0065, 0.0065, 0.036, 5), brass)
      // Cartridges stand across the belt.
      q.setFromUnitVectors(up, new Vector3(-tan.y, tan.x, 0).normalize())
      shellM.quaternion.copy(q)
      shellM.position.copy(p).add(new Vector3(0, 0, 0.012))
      g.add(shellM)
    }
  }
  space.add(g)
  const out = meshPieces(g, space, nearestWeights(f.body, onBones(f.body, TORSO_BONES)))
  g.removeFromParent()
  return out
}
