/**
 * What sets one face apart from the next under a hat brim, beyond his whiskers (cut from his own
 * sculpted beard, scene/whiskers.ts): a fitted full beard where there is none to cut, an eyepatch,
 * a scar, and the waistcoat that changes a torso's read.
 * Each is fitted to his measured head or torso (see outfit.ts `Fit`) and returned as bake Pieces,
 * so it rides his bones inside his one skinned mesh.
 */
import {
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

/** A waistcoat from the base of his neck to the belt, open in a V at the front. */
export function vest(f: Fit, color: number): Piece[] {
  const hips = f.at('Hips')
  const yTop = f.neck.lo - 0.035
  const yBot = hips.y + 0.04
  const samples = onBones(f.body, [...VEST_BONES, 'Hips'])
  const half = Math.PI - 0.16
  const geo = shell({
    samples,
    cx: f.at('Chest').x,
    cz: f.at('Chest').z,
    yTop,
    yBot,
    arc: Math.PI,
    half,
    // a deep V at the collar closing to the buttons at the belly
    taper: (t) => 1 - (1 - t) ** 1.6 * 0.24,
    rings: 8,
    segs: 26,
    margin: 0.014,
    bulge: () => 0.004,
    color: new Color(color),
  })
  return [
    {
      geo,
      roughness: 1,
      rim: FABRIC.wool.rim,
      swatch: 'wool',
      weights: nearestWeights(f.body, onBones(f.body, VEST_BONES)),
    },
  ]
}
