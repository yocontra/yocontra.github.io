/**
 * The poncho: a heavy striped wool blanket with a hole for his head, fitted to the man wearing it.
 *
 * It is shrink-wrapped to his posed neck, shoulders, chest and upper arms (fit.ts), measured on the
 * finished man, and then let fall: it slopes off the shoulders (never a shelf), drops over the
 * upper arms and hangs straight to mid-thigh in front and behind, shorter at the sides, no wider
 * than 1.3x his shoulders, with soft folds toward the hem.
 *
 * It is skinned in panels: the front and back to his chest (and a little to his thighs low down,
 * so a stride doesn't push through), the sides to his upper arms. When he draws or aims, the arm
 * lifts its side of the blanket, and the side over his holster is cut a little shorter, so the
 * gun hand and the holster stay in sight.
 */
import { type Bone, Color, type Vector3 } from 'three'
import type { Piece } from './bake.ts'
import type { GunSides } from './coat.ts'
import { nearestWeights, onBones, shell } from './fit.ts'
import { creaseNormals } from './normals.ts'
import type { Fit } from './outfit.ts'
import { SLOT, type Slot } from './roles.ts'
import { FABRIC } from './style.ts'

const TORSO = ['Chest', 'Torso', 'Abdomen', 'Hips', 'ShoulderL', 'ShoulderR', 'Neck']
const DRAPE = [...TORSO, 'UpperArmL', 'UpperArmR']
const SEGS = 28

const STRIPES: readonly [number, number, number][] = [
  // [top px, height px, colour] on the 64 px tall weave of the original poncho
  [8, 2, 0xe8_d8_b0],
  [12, 2, 0x1a_1a_1a],
  [16, 2, 0xc0_8a_2a],
  [20, 2, 0xe8_d8_b0],
  [44, 3, 0xe8_d8_b0],
  [49, 3, 0x1a_1a_1a],
  [54, 3, 0xc0_8a_2a],
  [59, 3, 0xe8_d8_b0],
]

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Ring positions and colours: a coarse grid plus doubled rings at the stripe edges (crisp bands). */
function weave(base: number): { ts: number[]; colors: number[] } {
  const stripeAt = (t: number): number => {
    const px = t * 64
    for (const [y, h, c] of STRIPES) {
      if (px >= y && px < y + h) {
        return c
      }
    }
    return base
  }
  const edges = new Set<number>([0, 0.05, 0.1, 1])
  for (let i = 1; i < 5; i++) {
    edges.add(i / 5)
  }
  for (const [y, h] of STRIPES) {
    edges.add(y / 64)
    edges.add((y + h) / 64)
  }
  const ts: number[] = []
  const colors: number[] = []
  for (const t of [...edges].sort((a, b) => a - b)) {
    const above = stripeAt(t - 1e-4)
    const below = stripeAt(t + 1e-4)
    if (above === below) {
      ts.push(t)
      colors.push(below)
    } else {
      ts.push(t, t)
      colors.push(above, below)
    }
  }
  return { ts, colors }
}

/** Soft folds: the lower blanket gathers in shallow vertical pleats. */
function fold(geo: ReturnType<typeof shell>, ts: readonly number[], cx: number, cz: number): void {
  const pos = geo.getAttribute('position')
  for (const [i, t] of ts.entries()) {
    const k = 0.011 * smooth(0.25, 1, t)
    for (let j = 0; j < SEGS; j++) {
      const v = i * SEGS + j
      const x = pos.getX(v) - cx
      const z = pos.getZ(v) - cz
      const a = Math.atan2(x, z)
      const out = k * (0.5 + 0.5 * Math.sin(a * 9))
      const r = Math.hypot(x, z) || 1
      pos.setXYZ(v, pos.getX(v) + (x / r) * out, pos.getY(v), pos.getZ(v) + (z / r) * out)
    }
  }
  pos.needsUpdate = true
  creaseNormals(geo)
}

/** His shoulders' half-width about `cx`: the outside of the upper arms at the shoulder joints. */
function shoulderHalf(f: Fit, cx: number): number {
  const y = f.at('UpperArmL').add(f.at('UpperArmR')).multiplyScalar(0.5).y
  let w = 0.15
  for (const s of onBones(f.body, ['UpperArmL', 'UpperArmR', 'ShoulderL', 'ShoulderR'])) {
    if (Math.abs(s.p.y - y) < 0.08) {
      w = Math.max(w, Math.abs(s.p.x - cx))
    }
  }
  return w
}

/** Panel weights: chest in front and behind, the upper arms at the sides, thighs low in front. */
function ponchoWeights(
  f: Fit,
  o: { cx: number; cz: number; sides: GunSides },
): (p: Vector3) => readonly (readonly [Bone, number])[] {
  const chest = nearestWeights(f.body, onBones(f.body, TORSO))
  const shY = f.at('UpperArmL').add(f.at('UpperArmR')).multiplyScalar(0.5).y
  const hipY = f.at('UpperLegL').add(f.at('UpperLegR')).multiplyScalar(0.5).y
  const kneeY = f.at('LowerLegL').add(f.at('LowerLegR')).multiplyScalar(0.5).y
  const arm = { L: f.bone('UpperArmL'), R: f.bone('UpperArmR') }
  const thigh = { L: f.bone('UpperLegL'), R: f.bone('UpperLegR') }
  return (p) => {
    const a = Math.atan2(p.x - o.cx, p.z - o.cz)
    // his left is +X
    const s = Math.sin(a) > 0 ? 'L' : 'R'
    const gun = o.sides.includes(s === 'R' ? 1 : -1)
    const side = smooth(0.4, 0.9, Math.abs(Math.sin(a)))
    const below = smooth(shY + 0.03, shY - 0.12, p.y)
    const ka = (gun ? 0.92 : 0.8) * side * below
    const kt = 0.3 * (1 - side) * smooth(hipY, mix(hipY, kneeY, 0.6), p.y)
    const out: [Bone, number][] = chest(p).map(([b, w]) => [b, w * (1 - ka - kt)])
    const ab = arm[s]
    if (ab) {
      out.push([ab, ka])
    }
    const u = smooth(-0.08, 0.08, p.x - o.cx)
    if (thigh.L && thigh.R) {
      out.push([thigh.L, kt * u], [thigh.R, kt * (1 - u)])
    }
    return out
  }
}

/**
 * The striped poncho, fitted to him. `sides` are the hips that carry a holster (the blanket is cut
 * a little shorter there and rides that arm more).
 */
export function poncho(f: Fit, hex: number, sides: GunSides): Piece[] {
  const chest = f.at('Chest')
  const cx = chest.x
  const cz = chest.z
  const yTop = f.neck.lo + 0.4 * (f.neck.hi - f.neck.lo)
  const hip = f.at('UpperLegL').add(f.at('UpperLegR')).multiplyScalar(0.5)
  const knee = f.at('LowerLegL').add(f.at('LowerLegR')).multiplyScalar(0.5)
  const wrist = f.at('WristL').add(f.at('WristR')).multiplyScalar(0.5)
  // mid-thigh in front and behind; at the sides it clears his hands
  const yBot = mix(hip.y, knee.y, 0.45)
  const ySide = Math.max(wrist.y + 0.05, yBot)
  const side = (yTop - ySide) / (yTop - yBot)
  const gunSide = (yTop - ySide - 0.05) / (yTop - yBot)
  const drop = (a: number): number => {
    const s2 = Math.sin(a) ** 2
    const gun = sides.includes(Math.sin(a) > 0 ? -1 : 1)
    return mix(1, gun ? gunSide : side, s2 * s2)
  }
  const width = 1.3 * 2 * shoulderHalf(f, cx)
  const margin = 0.018
  const { ts, colors } = weave(hex)
  const geo = shell({
    samples: onBones(f.body, DRAPE),
    cx,
    cz,
    yTop,
    yBot,
    ts,
    segs: SEGS,
    margin,
    bulge: (t) => t * 0.018,
    hang: true,
    grow: 1.7,
    drop,
    limit: (a) => (width * 0.5) / Math.max(0.05, Math.abs(Math.sin(a))) - margin,
    band: 0.03,
    color: (_t, i) => new Color(colors[i] ?? hex),
  })
  fold(geo, ts, cx, cz)
  // A blanket hides everything under it. Without this the shirt, sleeves and belt poke through
  // the poncho whenever its panels move (an arm lift shears the blanket against the chest).
  const hide = (p: Vector3, _bone: string, garment: Slot | undefined): boolean => {
    if (garment === undefined || !HIDEABLE.has(garment)) {
      return false
    }
    const a = Math.atan2(p.x - cx, p.z - cz)
    const hem = yTop + (yBot - yTop) * drop(a)
    return p.y > hem + 0.004 && p.y < yTop - 0.002
  }
  return [
    {
      geo,
      roughness: 1,
      rim: FABRIC.hessian.rim,
      swatch: FABRIC.hessian.swatch,
      weights: ponchoWeights(f, { cx, cz, sides }),
      unbelted: true,
      hide,
    },
  ]
}

/** Base garments the poncho covers (the gunbelt and hat are separate, on top). */
const HIDEABLE: ReadonlySet<Slot> = new Set([
  SLOT.Shirt,
  SLOT.Sleeves,
  SLOT.Bracer,
  SLOT.Belt,
  SLOT.Skin,
])
