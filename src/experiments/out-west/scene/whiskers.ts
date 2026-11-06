/**
 * Facial hair, cut from the base's own sculpted beard. Every male base carries one optional beard
 * mesh (tools/build-characters.ts): sculpted on the skin of the face, textured with the atlas's
 * hair (strands, a darker root, hair's roughness and normals) and skinned to the head. A
 * moustache, a goatee or side whiskers is that beard with every triangle outside its region
 * dropped, so each one sits on his lip or cheek exactly, follows the face (and its reshape,
 * scene/person.ts) and reads as hair rather than a moulded blob. It stays in his one baked mesh.
 *
 * Regions are in the beard's own units, measured on its bind mesh (the same sculpt on every base):
 * `a` across (0 at the philtrum, 1 at the widest), `s` up (0 under the chin, 1 at the top of the
 * side whiskers) and `d` forward (0 at the back of the jaw, 1 at the lip). The upper lip is
 * s ≈ 0.58–0.74 at the front with the mouth just under it, the jaw corners a ≈ 0.35–0.6, the
 * chin a < 0.3 below s ≈ 0.5, and the side whiskers a > 0.72 above s ≈ 0.6.
 */
import { type Object3D, type SkinnedMesh, Vector3 } from 'three'
import type { BeardKey, MoustacheKey } from '../data/outlaws.ts'
import { matSlot, skinnedOf } from './bind.ts'
import { SLOT } from './roles.ts'

/** The facial hair he wears (colours; styles default to a handlebar and the full sculpted beard). */
export interface WhiskerLook {
  moustache?: number | undefined
  moustacheStyle?: MoustacheKey | undefined
  beard?: number | undefined
  beardStyle?: BeardKey | undefined
  sideburns?: number | undefined
}

/** Whether to keep the sculpted beard: something he wears is cut from it. */
export function wearsWhiskers(o: WhiskerLook): boolean {
  return (
    o.moustache !== undefined ||
    o.sideburns !== undefined ||
    (o.beard !== undefined && o.beardStyle !== 'full')
  )
}

/** Is a triangle at (a across, s up, d forward), in beard units, part of this cut? */
type Region = (a: number, s: number, d: number) => boolean

/** Within half-width w and between heights lo and hi. */
const band = (a: number, s: number, [w, lo, hi]: readonly [number, number, number]): boolean =>
  a < w && s > lo && s < hi

const MOUSTACHE: Readonly<Record<MoustacheKey, Region>> = {
  // a lean bar over the lip whose waxed ends are turned up the cheeks (see `curl`)
  handlebar: (a, s, d) => d > 0.55 && band(a, s, [0.6, 0.6, 0.73]),
  // thick and wide, hanging down over the mouth
  walrus: (a, s, d) => d > 0.5 && band(a, s, [0.58, 0.5, 0.75]),
  // a thin line on the lip
  pencil: (a, s, d) => d > 0.6 && band(a, s, [0.42, 0.62, 0.7]),
  // full, trimmed at the mouth corners
  chevron: (a, s, d) => d > 0.55 && band(a, s, [0.5, 0.57, 0.74]),
  // a chevron whose ends run down past the mouth to the jaw
  horseshoe: (a, s, d) =>
    (d > 0.55 && band(a, s, [0.5, 0.57, 0.74])) ||
    (d > 0.52 && a > 0.32 && band(a, s, [0.54, 0.32, 0.74])),
}
const GOATEE: Region = (a, s, d) => d > 0.45 && band(a, s, [0.32, -1, 0.5])
const SIDEBURNS: Region = (a, s) => a > 0.72 && s > 0.6

/** The region he wears, or null for the whole sculpted beard. */
function regionFor(o: WhiskerLook): Region | null {
  if (o.beard !== undefined && (o.beardStyle ?? 'sculpted') === 'sculpted') {
    return null
  }
  const parts: Region[] = []
  if (o.moustache !== undefined) {
    parts.push(MOUSTACHE[o.moustacheStyle ?? 'handlebar'])
  }
  if (o.beard !== undefined && o.beardStyle === 'goatee') {
    parts.push(GOATEE)
  }
  if (o.sideburns !== undefined) {
    parts.push(SIDEBURNS)
  }
  return (a, s, d) => parts.some((r) => r(a, s, d))
}

/** The beard's bind-space box. */
interface Box {
  min: Vector3
  max: Vector3
  cx: number
}

function boxOf(pts: readonly Vector3[]): Box {
  const min = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  )
  const max = new Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  )
  for (const p of pts) {
    min.min(p)
    max.max(p)
  }
  return { min, max, cx: (min.x + max.x) / 2 }
}

/** A bind-space point in beard units (a, s, d). */
function units(v: Vector3, b: Box): [number, number, number] {
  return [
    Math.abs(v.x - b.cx) / Math.max(1e-6, (b.max.x - b.min.x) / 2),
    (v.y - b.min.y) / Math.max(1e-6, b.max.y - b.min.y),
    (v.z - b.min.z) / Math.max(1e-6, b.max.z - b.min.z),
  ]
}

/** Turn a handlebar's ends up the cheeks (bind space, in place): the lip band only. */
function curl(v: Vector3, b: Box): void {
  const [a, s] = units(v, b)
  if (a > 0.28 && a < 0.75 && s > 0.5 && s < 0.8) {
    v.y += (b.max.y - b.min.y) * 1.1 * (a - 0.28) ** 2
  }
}

/**
 * The triangles to keep, along the sculpt's own edge loops: a triangle stays when at least two of
 * its corners are inside, so the cut follows edges instead of leaving lone teeth.
 */
function keepAlongLoops(tri: readonly number[], inside: readonly boolean[]): number[] {
  const kept: number[] = []
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const corners = [tri[i] ?? 0, tri[i + 1] ?? 0, tri[i + 2] ?? 0]
    if (corners.filter((k) => inside[k]).length >= 2) {
      kept.push(...corners)
    }
  }
  return kept
}

/**
 * Taper the cut edge: each corner left outside the region is drawn most of the way to its inside
 * neighbours, so the whiskers thin to a soft point rather than ending in a ragged step.
 */
function taper(pts: Vector3[], kept: readonly number[], inside: readonly boolean[]): void {
  const sum = new Map<number, { p: Vector3; n: number }>()
  for (let i = 0; i + 2 < kept.length; i += 3) {
    const corners = [kept[i] ?? 0, kept[i + 1] ?? 0, kept[i + 2] ?? 0]
    for (const o of corners.filter((k) => !inside[k])) {
      for (const k of corners.filter((c) => inside[c])) {
        const acc = sum.get(o) ?? { p: new Vector3(), n: 0 }
        acc.p.add(pts[k] ?? acc.p)
        acc.n++
        sum.set(o, acc)
      }
    }
  }
  for (const [o, acc] of sum) {
    pts[o]?.lerp(acc.p.multiplyScalar(1 / acc.n), 0.7)
  }
}

/** Keep only the part of one sculpted beard mesh inside `region`. Returns the index count. */
function cut(sm: SkinnedMesh, region: Region, handlebar: boolean): number {
  const geo = sm.geometry.clone()
  sm.geometry = geo
  const pos = geo.getAttribute('position')
  const pts: Vector3[] = []
  for (let k = 0; k < pos.count; k++) {
    pts.push(new Vector3().fromBufferAttribute(pos, k).applyMatrix4(sm.bindMatrix))
  }
  const box = boxOf(pts)
  const inside = pts.map((p) => region(...units(p, box)))
  const index = geo.index
  const tri = index ? Array.from(index.array) : pts.map((_, i) => i)
  const kept = keepAlongLoops(tri, inside)
  taper(pts, kept, inside)
  for (const [k, v] of pts.entries()) {
    if (handlebar) {
      curl(v, box)
    }
    v.applyMatrix4(sm.bindMatrixInverse)
    pos.setXYZ(k, v.x, v.y, v.z)
  }
  pos.needsUpdate = true
  geo.setIndex(kept)
  geo.computeBoundingSphere()
  return kept.length
}

/**
 * Cut his whiskers from the sculpted beard (kept by prune when `wearsWhiskers`). A full beard
 * stays whole; a cut that keeps nothing removes the mesh.
 */
export function trimWhiskers(model: Object3D, o: WhiskerLook): void {
  const region = regionFor(o)
  if (!region) {
    return
  }
  const beards = skinnedOf(model).filter((m) => matSlot(m) === SLOT.Beard)
  const handlebar = o.moustache !== undefined && (o.moustacheStyle ?? 'handlebar') === 'handlebar'
  for (const sm of beards) {
    if (cut(sm, region, handlebar) === 0) {
      sm.removeFromParent()
    }
  }
}
