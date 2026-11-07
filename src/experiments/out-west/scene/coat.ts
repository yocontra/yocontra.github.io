/**
 * The long coat, cut as a coat: a body from the collar to the waist with an open front and turned
 * lapels, two skirt panels from the waist that hang straight to the knee (frock) or the calf
 * (duster) with a vent up the back, and two sleeves down to the wrist.
 *
 * Every part is shrink-wrapped to his posed surface (fit.ts), measured on the finished man (his
 * build, belly and scale are already on the bones), and skinned to the bones under it: the body to
 * his chest, each skirt panel from his hips into its own thigh (so the vent opens and the legs
 * read through it when he walks), each sleeve to its arm. On the gun side the skirt is cut away
 * behind the holster, as a gunfighter wears it.
 *
 * Whatever of his shirt, sleeves and belt the coat covers is taken off the base (bake.ts `hideUnder`), so
 * nothing pokes through and the coat costs no more triangles than he had.
 */
import { type Bone, Color, Matrix4, Vector3 } from 'three'
import type { CoatCut } from '../data/outlaw-types.ts'
import type { Piece } from './bake.ts'
import { nearestWeights, onBones, type Sample, shell } from './fit.ts'
import { creaseNormals } from './normals.ts'
import type { Fit } from './outfit.ts'
import { SLOT } from './roles.ts'
import { FABRIC } from './style.ts'

/** Which hips carry a holster (1 = his right, -X). */
export type GunSides = readonly (1 | -1)[]

interface Cut {
  /** Skirt length: 0 = the knee, 1 = the ankle. */
  hem: number
  /** Half-width of the open front at the collar, the lapel notch and the waist (radians). */
  open: readonly [number, number, number]
  /** Front edge of the skirt at the waist and at the hem (radians from the front). */
  front: readonly [number, number]
  /** The skirt's widest at the hem, as a multiple of his hips. */
  flare: number
  /** Where the back vent starts (0 = waist, 1 = hem) and how far it opens at the hem (radians). */
  vent: readonly [number, number]
  /** Cloth eases out toward the waist (duster) or follows it (frock). */
  loose: boolean
}

const CUTS: Readonly<Record<CoatCut, Cut>> = {
  duster: {
    hem: 0.55,
    open: [0.62, 0.44, 0.3],
    front: [0.45, 0.55],
    flare: 1.32,
    vent: [0.28, 0.09],
    loose: true,
  },
  frock: {
    hem: -0.04,
    open: [0.6, 0.38, 0.13],
    front: [0.2, 0.5],
    flare: 1.22,
    vent: [0.22, 0.06],
    loose: false,
  },
}

/** How far back the skirt is cut on a holstered hip (radians from the front). */
const HOLSTER_SWEEP = 1.85
const TORSO = ['Chest', 'Torso', 'Abdomen', 'Hips', 'ShoulderL', 'ShoulderR', 'Neck']
const SKIRT = ['Hips', 'Abdomen', 'UpperLegL', 'UpperLegR', 'LowerLegL', 'LowerLegR']
const LAPEL = 0.62

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

const wool = () => ({
  contactCloth: true,
  roughness: 1,
  rim: FABRIC.wool.rim,
  swatch: FABRIC.wool.swatch,
})

/** Half-width of the open front at body ring `t` (0 = collar, 1 = waist). */
function openAt(c: Cut, t: number): number {
  return t < 0.45
    ? mix(c.open[0], c.open[1], t / 0.45)
    : mix(c.open[1], c.open[2], (t - 0.45) / 0.55)
}

/** Turn the lapels: the front edges of the upper body darker (faced) and rolled out. */
function lapels(
  geo: ReturnType<typeof shell>,
  o: { cols: number; cx: number; cz: number; ts: readonly number[] },
): void {
  const { cols, cx, cz } = o
  const pos = geo.getAttribute('position')
  const col = geo.getAttribute('color')
  for (const [i, t] of o.ts.entries()) {
    if (t > LAPEL) {
      continue
    }
    const fade = 1 - t / LAPEL
    for (const [j, k] of [
      [0, 1],
      [1, 0.45],
      [cols - 2, 0.45],
      [cols - 1, 1],
    ] as const) {
      const v = i * cols + j
      const x = pos.getX(v) - cx
      const z = pos.getZ(v) - cz
      const r = Math.hypot(x, z) || 1
      const out = 0.012 * k * fade
      pos.setXYZ(v, pos.getX(v) + (x / r) * out, pos.getY(v), pos.getZ(v) + (z / r) * out)
      const d = 1 - 0.45 * k * fade
      col.setXYZ(v, col.getX(v) * d, col.getY(v) * d, col.getZ(v) * d)
    }
  }
  pos.needsUpdate = true
  col.needsUpdate = true
  creaseNormals(geo)
}

/** The coat's body, collar to waist, open at the front with lapels. */
function coatBody(f: Fit, c: Cut, color: Color): { piece: Piece; yTop: number; yBot: number } {
  const chest = f.at('Chest')
  const hips = f.at('Hips')
  const yTop = f.neck.lo + 0.15 * (f.neck.hi - f.neck.lo)
  const yBot = hips.y + 0.02
  const segs = 30
  const ts = [0, 0.04, 0.09, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
  // the shoulders end at the shoulder joints: the sleeve takes over there (no pads)
  const reachX = Math.min(
    Math.abs(f.at('UpperArmL').x - chest.x),
    Math.abs(f.at('UpperArmR').x - chest.x),
  )
  const geo = shell({
    samples: onBones(f.body, TORSO).filter((p) => Math.abs(p.p.x - chest.x) < reachX),
    cx: chest.x,
    cz: chest.z,
    yTop,
    yBot,
    ts,
    span: (t) => [openAt(c, t), 2 * Math.PI - openAt(c, t)],
    segs,
    margin: 0.014,
    bulge: (t) => 0.004 + (c.loose ? 0.012 * t : 0),
    color,
  })
  lapels(geo, { cols: segs + 1, cx: chest.x, cz: chest.z, ts })
  const weights = nearestWeights(f.body, onBones(f.body, TORSO))
  return { piece: { geo, ...wool(), weights }, yTop, yBot }
}

/** His hips' half-width about `cx`, from the surface at the hip joints. */
function hipHalfWidth(f: Fit, cx: number): number {
  const y = f.at('UpperLegL').add(f.at('UpperLegR')).multiplyScalar(0.5).y
  let w = 0.1
  for (const s of onBones(f.body, ['Hips', 'UpperLegL', 'UpperLegR'])) {
    if (Math.abs(s.p.y - y) < 0.06) {
      w = Math.max(w, Math.abs(s.p.x - cx))
    }
  }
  return w
}

/** One skirt panel (side 1 = his right, -X), waist to hem, cut back behind a holster. */
function panel(
  f: Fit,
  c: Cut,
  o: { side: 1 | -1; color: Color; holster: boolean; yTop: number; yBot: number },
): Piece {
  const hips = f.at('Hips')
  const cx = hips.x
  const cz = hips.z - 0.01
  const margin = 0.02
  const hipW = hipHalfWidth(f, cx)
  // never wider than his hips (times `flare` at the hem): it hangs straight, it doesn't flare
  const limit = (a: number, t: number): number =>
    (mix(1.04, c.flare, t) * hipW) / Math.max(0.05, Math.abs(Math.sin(a))) - margin
  const frontAt = (t: number): number => {
    const hem = mix(c.front[0], c.front[1], t)
    const notch = smooth(0, 0.2, t) * (1 - smooth(0.52, 0.82, t))
    return o.holster ? mix(hem, HOLSTER_SWEEP, notch) : hem
  }
  const ventAt = (t: number): number => c.vent[1] * smooth(c.vent[0], 1, t)
  // angles run from the front toward +X (his left): his left panel is (front, π), his right (π, 2π)
  const span = (t: number): readonly [number, number] =>
    o.side === -1
      ? [frontAt(t), Math.PI - ventAt(t)]
      : [Math.PI + ventAt(t), 2 * Math.PI - frontAt(t)]
  const geo = shell({
    samples: onBones(f.body, SKIRT).filter(
      (sample) => sample.slot === SLOT.Pants || sample.slot === SLOT.Boots,
    ),
    cx,
    cz,
    yTop: o.yTop,
    yBot: o.yBot,
    rings: 10,
    segs: 14,
    span,
    margin,
    bulge: (t) => t * 0.006,
    hang: true,
    limit,
    color: o.color,
  })
  // The skirt hangs as soft cloth around an elliptical hip, with sewn edges and broad folds.
  // It must not inherit the old tunic's wide, flat lower panels or the removed arm armor.
  const positions = geo.getAttribute('position')
  const colors = geo.getAttribute('color')
  for (let i = 0; i < positions.count; i++) {
    const t = Math.max(0, Math.min(1, (o.yTop - positions.getY(i)) / (o.yTop - o.yBot)))
    const x = positions.getX(i) - cx
    const z = positions.getZ(i) - cz
    const a = Math.atan2(x, z)
    const ellipse =
      1 /
      Math.hypot(
        Math.sin(a) / (hipW * mix(1.05, c.flare, t)),
        Math.cos(a) / (hipW * mix(0.88, 1.08, t)),
      )
    const radius =
      ellipse + (0.015 * Math.sin(a * 4 + o.side) + 0.004 * Math.sin(a * 9)) * smooth(0.12, 0.75, t)
    positions.setX(i, cx + Math.sin(a) * radius)
    positions.setZ(i, cz + Math.cos(a) * radius)
    const hem = smooth(0.88, 1, t)
    positions.setY(i, positions.getY(i) + 0.006 * Math.sin(a * 4) * hem)
    const edge = i % 15 === 0 || i % 15 === 14
    const shade = edge ? 0.82 : 1 - hem * 0.12
    colors.setXYZ(i, colors.getX(i) * shade, colors.getY(i) * shade, colors.getZ(i) * shade)
  }
  creaseNormals(geo, 65)
  const hipB = f.bone('Hips')
  const thigh = f.bone(o.side === 1 ? 'UpperLegR' : 'UpperLegL')
  const weights = (p: Vector3): readonly (readonly [Bone, number])[] => {
    if (!(hipB && thigh)) {
      return hipB ? [[hipB, 1]] : []
    }
    const t = Math.min(1, Math.max(0, (o.yTop - p.y) / (o.yTop - o.yBot)))
    const wh = 1 - 0.86 * smooth(0, 0.5, t)
    return [
      [hipB, wh],
      [thigh, 1 - wh],
    ]
  }
  return { geo, ...wool(), weights }
}

/** A ring stack round the bone segment `from` → `to` (shell() in the segment's own frame). */
function tube(
  samples: readonly Sample[],
  from: Vector3,
  to: Vector3,
  o: {
    rings: number
    segs: number
    margin: number
    flare: number
    color: Color
  },
): ReturnType<typeof shell> {
  const axis = from.clone().sub(to)
  const len = axis.length()
  const y = axis.normalize()
  const fwd = new Vector3(0, 0, 1)
  const z = fwd.sub(y.clone().multiplyScalar(fwd.dot(y)))
  if (z.lengthSq() < 1e-6) {
    z.set(1, 0, 0)
  }
  z.normalize()
  const x = new Vector3().crossVectors(y, z)
  const m = new Matrix4().makeBasis(x, y, z).setPosition(to)
  const inv = m.clone().invert()
  const local = samples.map((s) => ({ ...s, p: s.p.clone().applyMatrix4(inv) }))
  const geo = shell({
    samples: local,
    cx: 0,
    cz: 0,
    yTop: len,
    yBot: 0,
    rings: o.rings,
    segs: o.segs,
    margin: o.margin,
    bulge: (t) => t * o.flare,
    minR: 0.03,
    color: o.color,
  })
  geo.applyMatrix4(m)
  creaseNormals(geo)
  return geo
}

/** A coat sleeve, shoulder to wrist, in two tubes that overlap at the elbow. */
function sleeve(f: Fit, s: 'L' | 'R', color: Color): { pieces: Piece[]; segs: Seg[] } {
  const sh = f.at(`UpperArm${s}`)
  const el = f.at(`LowerArm${s}`)
  const wr = f.at(`Wrist${s}`)
  const upDir = sh.clone().sub(el).normalize()
  const loDir = el.clone().sub(wr).normalize()
  const upper: Seg = {
    from: sh.clone().addScaledVector(upDir, 0.025),
    to: el.clone().addScaledVector(upDir, -0.03),
    bones: [`UpperArm${s}`],
  }
  const lower: Seg = {
    from: el.clone().addScaledVector(loDir, 0.03),
    to: wr.clone().addScaledVector(loDir, 0.012),
    bones: [`LowerArm${s}`],
  }
  const weights = nearestWeights(
    f.body,
    onBones(f.body, [`UpperArm${s}`, `LowerArm${s}`, `Shoulder${s}`]),
  )
  const make = (g: Seg, rings: number): Piece => ({
    geo: tube(onBones(f.body, g.bones), g.from, g.to, {
      rings,
      segs: 12,
      margin: 0.012,
      flare: rings > 5 ? 0.008 : 0.002,
      color,
    }),
    ...wool(),
    weights,
    unbelted: true,
  })
  return {
    pieces: [make(upper, 5), make(lower, 6)],
    segs: [upper, lower],
  }
}

/** A sleeve tube's axis, for hiding the base sleeve under it. */
interface Seg {
  from: Vector3
  to: Vector3
  bones: string[]
}

/**
 * The coat, fitted to him. `sides` are the hips that carry a holster (the skirt is cut back
 * behind them).
 */
export function coat(f: Fit, hex: number, cut: CoatCut, sides: GunSides): Piece[] {
  const c = CUTS[cut]
  const color = new Color(hex)
  const hips = f.at('Hips')
  const knee = f.at('LowerLegL').add(f.at('LowerLegR')).multiplyScalar(0.5)
  const foot = f.at('FootL').add(f.at('FootR')).multiplyScalar(0.5)
  const b = coatBody(f, c, color)
  const yTop = hips.y + 0.08
  const yBot = knee.y - c.hem * (knee.y - foot.y)
  const skirts = ([1, -1] as const).map((side) =>
    panel(f, c, { side, color, holster: sides.includes(side), yTop, yBot }),
  )
  const arms = (['L', 'R'] as const).map((s) => sleeve(f, s, color))
  const chest = f.at('Chest')
  const segs = arms.flatMap((a) => a.segs)
  b.piece.hide = (p, bone, garment) => {
    // the king's shoulder plate would stand through the coat's shoulder
    if (garment === SLOT.Pauldron) {
      return true
    }
    // a coated arm: the base shirt, skin and bracer are all under the coat sleeve now
    if (segs.some((g) => g.bones.includes(bone))) {
      return true
    }
    if (!TORSO.includes(bone) || p.y < b.yBot + 0.005 || p.y > b.yTop + 0.015) {
      return false
    }
    const t = (b.yTop - p.y) / (b.yTop - b.yBot)
    const a = Math.abs(Math.atan2(p.x - chest.x, p.z - chest.z))
    return a > openAt(c, t) + 0.14
  }
  return [b.piece, ...skirts, ...arms.flatMap((a) => a.pieces)]
}
