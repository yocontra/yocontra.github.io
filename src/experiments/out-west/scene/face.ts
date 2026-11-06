/**
 * What sets one face apart from the next under a hat brim, beyond his whiskers (cut from his own
 * sculpted beard, scene/whiskers.ts): a fitted full beard where there is none to cut, an eyepatch,
 * a scar, and the waistcoat that changes a torso's read.
 * Each is fitted to his measured head or torso (see outfit.ts `Fit`) and returned as bake Pieces,
 * so it rides his bones inside his one skinned mesh.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three'
import type { BeardKey } from '../data/outlaws.ts'
import { meshPieces, onBone, type Piece } from './bake.ts'
import { nearestWeights, onBones, reach, shell } from './fit.ts'
import type { Fit } from './outfit.ts'
import { SLOT, type Slot } from './roles.ts'
import { FABRIC } from './style.ts'

const HEAD = ['Head']

/**
 * His skin's distance from the head's axis toward angle `a` at height `y` (or `fallback`): hair,
 * brows and a sculpted beard stand off the face and would float whatever sits on it.
 */
function surface(f: Fit, y: number, a: number, fallback: number): number {
  const h = f.head
  const skin = onBones(f.body, HEAD).filter((s) => s.mat === 'Skin')
  const z = reach(skin, { cx: h.cx, cz: h.cz, y, a, dy: 0.012, da: 0.25 })
  return Number.isFinite(z) ? z : fallback
}

/** Bake a group built in his root space onto his head bone, then drop it. */
function onHead(f: Fit, g: Group, space: Object3D): Piece[] {
  const b = f.bone('Head')
  if (!b) {
    return []
  }
  space.add(g)
  const out = meshPieces(g, space, onBone(b))
  g.removeFromParent()
  return out
}

/** A beard that isn't the base's sculpted one: a full shell over the jaw, or a goatee. */
export function beard(f: Fit, color: number, style: BeardKey | undefined): Piece[] {
  const h = f.head
  const goatee = style === 'goatee'
  const geo = shell({
    samples: onBones(f.body, HEAD),
    cx: h.cx,
    cz: h.cz,
    yTop: h.chin + (goatee ? 0.3 : 0.42) * (h.eye - h.chin),
    yBot: h.chin - (goatee ? 0.035 : 0.03),
    arc: 0,
    half: goatee ? 0.5 : 1.75,
    taper: (t) => (goatee ? 1 - 0.3 * t : 1 - 0.35 * t),
    rings: 6,
    segs: goatee ? 8 : 16,
    margin: 0.008,
    bulge: (t) => (goatee ? 0.012 : 0.02) * Math.sin(Math.PI * Math.min(1, t * 1.2)),
    band: 0.012,
    color: new Color(color),
  })
  const b = f.bone('Head')
  return b ? [{ geo, roughness: 1, rim: FABRIC.wool.rim, swatch: 'wool', weights: onBone(b) }] : []
}

/** A leather patch over his left eye, its cord across the brow and round the back of his head. */
export function eyepatch(f: Fit, space: Object3D): Piece[] {
  const h = f.head
  const leather = new MeshStandardMaterial({ color: 0x14_10_0c, roughness: 0.5 })
  leather.userData.rim = FABRIC.leather.rim
  leather.userData.swatch = 'leather'
  const eyes = onBones(f.body, HEAD).filter((s) => s.mat === 'Eye' && s.p.x > h.cx)
  const eye = eyes
    .reduce((t, s) => t.add(s.p), new Vector3())
    .multiplyScalar(1 / Math.max(1, eyes.length))
  if (eyes.length === 0) {
    eye.set(h.cx + 0.032, h.eye, h.cz + 0.09)
  }
  const g = new Group()
  const patch = new Mesh(new SphereGeometry(0.024, 10, 6), leather)
  patch.scale.set(1, 0.82, 0.32)
  patch.position.set(eye.x, eye.y, eye.z + 0.008)
  g.add(patch)
  // the cord: from the patch up across the brow, round the back at the crown band, and back
  const pts: Vector3[] = []
  const n = 16
  for (let i = 0; i < n; i++) {
    const a = 0.42 - (i / n) * Math.PI * 2
    const u = (i / n) * Math.PI * 2
    const y = eye.y + 0.008 + 0.038 * Math.sin(u / 2)
    const r = surface(f, y, a, h.r)
    pts.push(new Vector3(h.cx + Math.sin(a) * (r + 0.004), y, h.cz + Math.cos(a) * (r + 0.004)))
  }
  const cord = new Mesh(
    new TubeGeometry(new CatmullRomCurve3(pts, true), 40, 0.0035, 4, true),
    leather,
  )
  g.add(cord)
  return onHead(f, g, space)
}

/** An old knife scar down his right cheek. */
export function scar(f: Fit, space: Object3D): Piece[] {
  const h = f.head
  const y = h.chin + 0.62 * (h.eye - h.chin)
  const a = -0.62
  const r = surface(f, y, a, 0.08)
  const mat = new MeshStandardMaterial({ color: 0x8a_4a_3e, roughness: 0.45 })
  const m = new Mesh(new SphereGeometry(0.03, 8, 4), mat)
  m.scale.set(0.1, 1.05, 0.1)
  m.rotation.set(0, a, -0.55)
  m.position.set(h.cx + Math.sin(a) * (r + 0.001), y, h.cz + Math.cos(a) * (r + 0.001))
  const g = new Group()
  g.add(m)
  return onHead(f, g, space)
}

const VEST_BONES = ['Chest', 'Torso', 'Abdomen', 'ShoulderL', 'ShoulderR']
/** The bones a vest shoulder strap follows (never the upper arm: the arm passes under it). */
const STRAP_BONES = ['Chest', 'Torso', 'ShoulderL', 'ShoulderR']

/** A point on the body's surface in the shoulder's front–top–back plane, at `x`. */
function shoulderRail(
  f: Fit,
  x: number,
  o: { pivot: Vector3; n: number; frontY: number; backY: number },
): Vector3[] {
  const { pivot } = o
  const near = f.body.samples.filter((s) => Math.abs(s.p.x - x) < 0.032)
  const pts: Vector3[] = []
  // Start and end on the band's top edge at the front and the back, so the strap joins the body
  // of the waistcoat instead of hovering over the shoulder like an epaulette.
  const edgeZ = (y: number, front: boolean): number => {
    let z = front ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    for (const s of near) {
      if (Math.abs(s.p.y - y) > 0.055) {
        continue
      }
      z = front ? Math.max(z, s.p.z) : Math.min(z, s.p.z)
    }
    return (Number.isFinite(z) ? z : pivot.z + (front ? 0.12 : -0.12)) + (front ? 0.012 : -0.012)
  }
  pts.push(new Vector3(x, o.frontY, edgeZ(o.frontY, true)))
  for (let i = 0; i < o.n; i++) {
    // 0 = the chest in front, π/2 = the top of the shoulder, π = the back
    const phi = 0.18 + ((Math.PI - 0.36) * i) / (o.n - 1)
    const dir = new Vector3(0, Math.sin(phi), Math.cos(phi))
    let best = 0
    for (const s of near) {
      const v = s.p.clone().sub(pivot)
      const along = v.dot(dir)
      if (along <= 0) {
        continue
      }
      // close to this ray: a strap stays on the shoulder, not on a hand hanging beside it
      if (v.lengthSq() - along * along > 0.03 * 0.03) {
        continue
      }
      best = Math.max(best, along)
    }
    pts.push(pivot.clone().addScaledVector(dir, best + 0.012))
  }
  pts.push(new Vector3(x, o.backY, edgeZ(o.backY, false)))
  return pts
}

/**
 * One shoulder strap of the waistcoat: a flat band from the top of the front panel, over the
 * shoulder, to the back. Two rails follow the body at its inner and outer edge, so the band lies
 * on the shoulder instead of cutting through it. The arm passes under it (it is weighted to the
 * chest and clavicle, not the upper arm).
 */
function vestStrap(
  f: Fit,
  side: 1 | -1,
  color: Color,
  o: { cx: number; spread: number; frontY: number; backY: number },
): { geo: ReturnType<typeof shell>; hide: (p: Vector3) => boolean } {
  const chest = f.at('Chest')
  const pivot = new Vector3(chest.x, chest.y + 0.02, chest.z)
  const xIn = o.cx + side * o.spread * 0.42
  const xOut = o.cx + side * o.spread * 0.72
  const n = 10
  const inner = shoulderRail(f, xIn, { ...o, pivot, n })
  const outer = shoulderRail(f, xOut, { ...o, pivot, n })
  const rows = inner.length
  const pos: number[] = []
  const col: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (const [k, rail] of [inner, outer].entries()) {
    for (const [i, p] of rail.entries()) {
      pos.push(p.x, p.y, p.z)
      col.push(color.r, color.g, color.b)
      uv.push(k, i / (rows - 1))
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    const p = i * 2
    // (front → back) × (inner → outer) faces out of the shoulder on his left
    if (side === 1) {
      idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3)
    } else {
      idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  // every normal points away from the chest: the band is a ribbon over a round shoulder
  const nrm = geo.getAttribute('normal')
  const v = new Vector3()
  for (let i = 0; i < nrm.count; i++) {
    v.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0).sub(pivot)
    if (nrm.getX(i) * v.x + nrm.getY(i) * v.y + nrm.getZ(i) * v.z < 0) {
      nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i))
    }
  }
  nrm.needsUpdate = true
  const lo = Math.min(xIn, xOut) - 0.028
  const hi = Math.max(xIn, xOut) + 0.028
  return {
    geo,
    hide: (p) => p.x >= lo && p.x <= hi && Math.abs(p.z - chest.z) < 0.19,
  }
}

/**
 * A waistcoat from the belt to the armpits: one buttoned band round the torso, dipping to a V at
 * the front, and a narrow strap over each shoulder. The band and straps hide the shirt under
 * them, so nothing pokes through while he moves; the chest above the V stays shirt.
 */
export function vest(f: Fit, color: number): Piece[] {
  const hips = f.at('Hips')
  const chest = f.at('Chest')
  const shY = (f.at('UpperArmL').y + f.at('UpperArmR').y) / 2
  const cx = chest.x
  const cz = chest.z
  const yTop = shY - 0.09
  const yBot = hips.y + 0.03
  // the V: the top edge falls toward the front centre, so the chest opens between the straps
  const topAt = (a: number): number => yTop - 0.07 * Math.max(0, Math.cos(a)) ** 2
  const samples = onBones(f.body, [...VEST_BONES, 'Hips'])
  const band = shell({
    samples,
    cx,
    cz,
    yTop,
    yBot,
    top: topAt,
    rings: 12,
    segs: 30,
    margin: 0.015,
    bulge: (t) => 0.004 + 0.006 * t,
    color: new Color(color),
  })
  const spread = Math.abs(f.at('UpperArmL').x - cx)
  const straps = ([1, -1] as const).map((side) =>
    vestStrap(f, side, new Color(color), {
      cx,
      spread,
      frontY: topAt(0) - 0.005,
      backY: topAt(Math.PI) - 0.005,
    }),
  )
  const weights = nearestWeights(f.body, onBones(f.body, VEST_BONES))
  const strapWeights = nearestWeights(f.body, onBones(f.body, STRAP_BONES))
  const hide = (p: Vector3, _bone: string, garment: Slot | undefined): boolean => {
    if (garment !== SLOT.Shirt && garment !== SLOT.Sleeves) {
      return false
    }
    // nothing under the band (keep the shirt in the V above its dipping top edge); the sleeves
    // are the arms, which the band does not cover, so only the shirt goes
    if (garment === SLOT.Shirt) {
      const a = Math.atan2(p.x - cx, p.z - cz)
      if (p.y > yBot - 0.02 && p.y < topAt(a) - 0.004) {
        return true
      }
    }
    // nor under a shoulder strap: the shirt's shoulder and the top of the sleeve there
    return straps.some((s) => s.hide(p) && p.y > yTop - 0.06)
  }
  const piece: Piece = {
    geo: band,
    roughness: 1,
    rim: FABRIC.wool.rim,
    swatch: 'wool',
    weights,
    hide,
  }
  const out: Piece[] = [
    piece,
    ...straps.map((s) => ({
      geo: s.geo,
      roughness: 1,
      rim: FABRIC.wool.rim,
      swatch: 'wool' as const,
      weights: strapWeights,
      hide,
    })),
  ]
  return out
}
