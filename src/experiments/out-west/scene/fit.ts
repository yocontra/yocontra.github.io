// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh/isSkinnedMesh flags are typed `true` on the cast type; testing them is the runtime type check
/**
 * Fitting clothes to a posed character.
 *
 * Every outlaw is one whole character on the shared Quaternius rig. Instead of
 * guessing offsets per model, we sample his skinned surface in the pose he is
 * dressed in (idle, frame 0) and shrink-wrap the procedural clothes around it:
 * a coat hugs his hips and thighs, a bandana his neck, a beard his jaw. Each
 * garment is then skinned to the same bones as the surface under it (weights
 * copied from the nearest body vertices), so it moves with him through every
 * clip instead of floating on one bone.
 *
 * All coordinates are in the actor's root space: metres, Y up, facing +Z, his
 * right hand at -X.
 */
import {
  type Bone,
  BufferAttribute,
  BufferGeometry,
  type Color,
  type Object3D,
  type SkinnedMesh,
  Vector3,
} from 'three'

export interface Sample {
  readonly p: Vector3
  /** Bone with the largest weight on this vertex. */
  readonly bone: string
  /** Material name of the primitive the vertex belongs to. */
  readonly mat: string
  /** Up to four (bone index, weight) pairs, bone index into `Body.bones`. */
  readonly w: readonly (readonly [number, number])[]
}

export interface Body {
  readonly samples: readonly Sample[]
  readonly bones: readonly Bone[]
}

const PUNCT = /[.\s]/gu
const DUP_SUFFIX = /_\d+$/u
const strip = (n: string) => n.replace(PUNCT, '').replace(DUP_SUFFIX, '')

/** Bone name without the punctuation GLTFLoader may or may not keep ("UpperLeg.R" → "UpperLegR"). */
export const boneKey = strip

/**
 * Sample every vertex of every skinned mesh under `model`, posed, in the
 * space of `space` (the actor root). Call after the mixer has posed him and
 * world matrices are current.
 */
export function sampleBody(model: Object3D, space: Object3D): Body {
  const bones: Bone[] = []
  const index = new Map<Bone, number>()
  const samples: Sample[] = []
  const inv = space.matrixWorld.clone().invert()
  const v = new Vector3()
  model.traverse((o) => {
    const sm = o as SkinnedMesh
    if (!sm.isSkinnedMesh) {
      return
    }
    const mat = Array.isArray(sm.material) ? sm.material[0] : sm.material
    const matName = mat?.name ?? ''
    const toSpace = inv.clone().multiply(sm.matrixWorld)
    const local = sm.skeleton.bones.map((b) => {
      let i = index.get(b)
      if (i === undefined) {
        i = bones.length
        bones.push(b)
        index.set(b, i)
      }
      return i
    })
    const pos = sm.geometry.getAttribute('position')
    const si = sm.geometry.getAttribute('skinIndex')
    const sw = sm.geometry.getAttribute('skinWeight')
    for (let k = 0; k < pos.count; k++) {
      sm.getVertexPosition(k, v)
      const w: [number, number][] = []
      let best = -1
      let bestW = 0
      for (let c = 0; c < 4; c++) {
        const weight = sw.getComponent(k, c)
        if (weight <= 0) {
          continue
        }
        const bi = local[si.getComponent(k, c)] ?? 0
        w.push([bi, weight])
        if (weight > bestW) {
          bestW = weight
          best = bi
        }
      }
      samples.push({
        p: v.clone().applyMatrix4(toSpace),
        bone: best >= 0 ? strip(bones[best]?.name ?? '') : '',
        mat: matName,
        w,
      })
    }
  })
  return { samples, bones }
}

/** Keep samples whose dominant bone is one of `names` (punctuation-free, e.g. "UpperLegR"). */
export function onBones(body: Body, names: readonly string[]): Sample[] {
  const set = new Set(names)
  return body.samples.filter((s) => set.has(s.bone))
}

export interface Bounds {
  min: Vector3
  max: Vector3
  center: Vector3
}

export function bounds(samples: readonly Sample[]): Bounds {
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
  for (const s of samples) {
    min.min(s.p)
    max.max(s.p)
  }
  return { min, max, center: min.clone().add(max).multiplyScalar(0.5) }
}

/** Where to probe for `reach`: a height band and a direction cone around (cx, cz). */
export interface Probe {
  cx: number
  cz: number
  y: number
  /** Direction, radians from +Z toward +X. */
  a: number
  /** ± height band, metres. */
  dy: number
  /** ± cone half-angle, radians. */
  da?: number
}

/**
 * Largest distance of `samples` from (cx, cz) along direction `a`, within the
 * probe's height band and cone. NaN if nothing is there.
 */
export function reach(samples: readonly Sample[], q: Probe): number {
  const dx = Math.sin(q.a)
  const dz = Math.cos(q.a)
  const da = q.da ?? 0.4
  let best = Number.NaN
  for (const s of samples) {
    const x = s.p.x - q.cx
    const z = s.p.z - q.cz
    const along = x * dx + z * dz
    const inBand = Math.abs(s.p.y - q.y) <= q.dy
    if (inBand && along > 0 && Math.atan2(Math.abs(-x * dz + z * dx), along) <= da) {
      best = Number.isNaN(best) ? along : Math.max(best, along)
    }
  }
  return best
}

export interface ShellSpec {
  /** Surface the shell wraps. */
  samples: readonly Sample[]
  cx: number
  cz: number
  yTop: number
  yBot: number
  /** Arc centre (radians from +Z toward +X) and half-width. Full ring: half = π. */
  arc?: number
  half?: number
  rings?: number
  segs?: number
  /** Gap kept between the surface and the cloth, metres. */
  margin: number
  /** Extra radius as a function of t (0 = top ring, 1 = bottom ring). */
  bulge?: (t: number) => number
  /** Arc half-width multiplier per ring (taper to a point for a bandana flap). */
  taper?: (t: number) => number
  /** Cloth hangs: never narrower than the ring above. */
  hang?: boolean
  /** Minimum radius where the surface has nothing to wrap. */
  minR?: number
  /** Height band to sample at each ring (± metres). */
  band?: number
  /** Ring positions (0 = top, 1 = bottom); overrides `rings`. Repeat a t for a crisp colour edge. */
  ts?: readonly number[]
  /** Colour per ring (linear sRGB), or one colour. */
  color: Color | ((t: number, ring: number) => Color)
}

/** Resolved ring layout shared by the shell's passes. */
interface Layout {
  ts: readonly number[]
  segs: number
  cols: number
  full: boolean
  minR: number
  band: number
  /** Height and arc (start angle, step) of ring i. */
  ring: (i: number) => { t: number; y: number; a0: number; step: number }
}

function layout(s: ShellSpec): Layout {
  const ts = s.ts ?? Array.from({ length: (s.rings ?? 8) + 1 }, (_, i) => i / (s.rings ?? 8))
  const segs = s.segs ?? 20
  const half = s.half ?? Math.PI
  const full = half >= Math.PI - 1e-6
  const rings = ts.length - 1
  return {
    ts,
    segs,
    full,
    cols: full ? segs : segs + 1,
    minR: s.minR ?? 0.04,
    band: s.band ?? Math.max(0.012, Math.abs(s.yTop - s.yBot) / rings / 1.5),
    ring: (i) => {
      const t = ts[i] ?? 0
      const h = half * (s.taper ? s.taper(t) : 1)
      return { t, y: s.yTop + (s.yBot - s.yTop) * t, a0: (s.arc ?? 0) - h, step: (2 * h) / segs }
    },
  }
}

/** Surface radius per column of one ring, holes filled, smoothed without dipping inside. */
function ringRadii(s: ShellSpec, L: Layout, i: number): number[] {
  const { y, a0, step } = L.ring(i)
  const row: number[] = []
  for (let j = 0; j < L.cols; j++) {
    const q = { cx: s.cx, cz: s.cz, y, a: a0 + step * j, dy: L.band, da: Math.max(0.25, step) }
    row.push(reach(s.samples, q))
  }
  const known = row.filter((x) => Number.isFinite(x))
  const fallback = known.length > 0 ? Math.min(...known) : L.minR
  const filled = row.map((x) => (Number.isFinite(x) ? x : fallback))
  const wrap = (j: number) =>
    L.full ? (j + L.cols) % L.cols : Math.min(L.cols - 1, Math.max(0, j))
  // Dilate then average: smooth, but never inside the surface.
  const dil = filled.map((_, j) =>
    Math.max(filled[wrap(j - 1)] ?? 0, filled[j] ?? 0, filled[wrap(j + 1)] ?? 0),
  )
  return dil.map((_, j) =>
    Math.max(L.minR, ((dil[wrap(j - 1)] ?? 0) + 2 * (dil[j] ?? 0) + (dil[wrap(j + 1)] ?? 0)) / 4),
  )
}

function quads(L: Layout): number[] {
  const idx: number[] = []
  for (let i = 0; i < L.ts.length - 1; i++) {
    for (let j = 0; j < L.segs; j++) {
      const j1 = L.full ? (j + 1) % L.cols : j + 1
      const a = i * L.cols + j
      const b = i * L.cols + j1
      const c = (i + 1) * L.cols + j
      const d = (i + 1) * L.cols + j1
      idx.push(a, c, b, b, c, d)
    }
  }
  return idx
}

/** Closest-fitting ring stack around the samples. Returns root-space geometry with vertex colours. */
export function shell(s: ShellSpec): BufferGeometry {
  const L = layout(s)
  const r = L.ts.map((_, i) => ringRadii(s, L, i))
  if (s.hang) {
    for (let i = 1; i < r.length; i++) {
      const above = r[i - 1] ?? []
      r[i] = (r[i] ?? []).map((x, j) => Math.max(x, above[j] ?? 0))
    }
  }
  const pos: number[] = []
  const col: number[] = []
  r.forEach((row, i) => {
    const { t, y, a0, step } = L.ring(i)
    const c = typeof s.color === 'function' ? s.color(t, i) : s.color
    const extra = s.margin + (s.bulge ? s.bulge(t) : 0)
    row.forEach((rad, j) => {
      const a = a0 + step * j
      pos.push(s.cx + Math.sin(a) * (rad + extra), y, s.cz + Math.cos(a) * (rad + extra))
      col.push(c.r, c.g, c.b)
    })
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
  g.setIndex(quads(L))
  g.computeVertexNormals()
  return g
}

export type WeightFn = (p: Vector3) => readonly (readonly [Bone, number])[]

/**
 * Weights copied from the `k` nearest body samples (inverse-distance blend),
 * restricted to `from` so a poncho doesn't grab a hand that hangs near it.
 */
export function nearestWeights(body: Body, from: readonly Sample[], k = 4): WeightFn {
  return (p) => {
    const best: { d: number; s: Sample }[] = []
    for (const s of from) {
      const d = s.p.distanceToSquared(p)
      if (best.length < k) {
        best.push({ d, s })
        best.sort((x, y) => x.d - y.d)
      } else if (d < (best[k - 1]?.d ?? 0)) {
        best[k - 1] = { d, s }
        best.sort((x, y) => x.d - y.d)
      }
    }
    const acc = new Map<number, number>()
    for (const { d, s } of best) {
      const f = 1 / (Math.sqrt(d) + 0.005)
      for (const [bi, w] of s.w) {
        acc.set(bi, (acc.get(bi) ?? 0) + w * f)
      }
    }
    return [...acc.entries()]
      .map(([bi, w]) => [body.bones[bi] as Bone, w] as const)
      .filter(([b]) => b !== undefined)
  }
}
