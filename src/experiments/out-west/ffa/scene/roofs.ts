// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one roof builder walks bays, slopes, ends and trims in a single pass over shared local coordinates
/**
 * Pitched roofs for Perdition, which the top-down camera sees more of than anything else.
 *
 * - Gabled buildings keep their steep gable; false-front buildings get the real western roof
 *   behind the front: a low gable running back from the street (two side by side on the wide
 *   ones), its ridge kept under the false front's top so the street face still hides it.
 * - Every roof has a ridge cap, fascia boards along the eaves and barge boards up the rakes, and
 *   a shingle or corrugated-tin skin drawn in the roof material's shader from per-vertex data (no
 *   new textures, still one draw for every roof in town).
 *
 * Roof vertices carry `rk`: 0 = plain boards (trim, the clock tower), 1 = shingles, 2 = tin.
 * Skinned surfaces get UVs in metres/2: u along the ridge, v down the slope from it.
 */
import { BufferAttribute, type BufferGeometry, type MeshStandardMaterial, Vector3 } from 'three'
import type { GeoBuilder } from '../../scene/geo.ts'
import { GeoBuilder as Geo } from '../../scene/geo.ts'
import type { Building, BuildingKind, Side } from '../sim/layout.ts'

export const RK_PLAIN = 0
export const RK_SHINGLE = 1
export const RK_TIN = 2

export type RoofSkin = 'shingle' | 'tin'

/** Metres per UV unit on the skinned surfaces (matches the roof map's tiling). */
const UV_M = 2

export interface RoofSpec {
  b: Building
  /** Ridge direction. */
  axis: 'x' | 'z'
  /** Ridge height above the wall top. */
  rise: number
  /** Side-by-side gables across the span (wide false-front buildings). */
  bays: number
  overhang: number
  /** The end hidden by a false front: no overhang, no gable wall, no barge boards. */
  front: Side | null
  skin: RoofSkin
  color: number
  trim: number
  wallColor: number
}

/** A skin's surface, its trim, and the gable-end walls (in the wall material). */
export interface RoofParts {
  geometry: BufferGeometry
  /** Roof surface height at (x, z) (for things standing on it). */
  heightAt: (x: number, z: number) => number
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z)

/** Which end of a ridge along each axis a false front on each side sits at (−1 low, 1 high). */
const FRONT_END: Record<'x' | 'z', Partial<Record<Side, -1 | 1>>> = {
  x: { w: -1, e: 1 },
  z: { n: -1, s: 1 },
}

/**
 * Build in a local frame where the ridge runs along `a` (the building's x or z) and the span runs
 * across it along `c`, then map back. `toWorld(a, y, c)`.
 */
function frame(spec: RoofSpec) {
  const { b, axis } = spec
  const alongX = axis === 'x'
  return {
    a0: alongX ? b.x : b.z,
    a1: alongX ? b.x + b.w : b.z + b.d,
    c0: alongX ? b.z : b.x,
    c1: alongX ? b.z + b.d : b.x + b.w,
    toWorld: (a: number, y: number, c: number) => (alongX ? V(a, y, c) : V(c, y, a)),
    /** Which end of the ridge is the false front: −1 the a0 end, 1 the a1 end, 0 neither. */
    frontEnd: spec.front === null ? 0 : (FRONT_END[axis][spec.front] ?? 0),
  }
}

/** Push one skinned quad (corners in world space) with explicit metre UVs. */
function skinQuad(
  g: GeoBuilder,
  p: [Vector3, Vector3, Vector3, Vector3],
  uv: number[],
  color: number,
): void {
  const [a, b, c] = p
  const up = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).y > 0
  // reversed winding keeps each corner's UV with it
  const order = up ? [0, 1, 2, 3] : [0, 3, 2, 1]
  const q = order.map((i) => p[i] as Vector3) as [Vector3, Vector3, Vector3, Vector3]
  const t = order.flatMap((i) => [(uv[i * 2] ?? 0) / UV_M, (uv[i * 2 + 1] ?? 0) / UV_M])
  g.quadUV(q, t as [number, number, number, number, number, number, number, number], color)
}

export function buildRoof(spec: RoofSpec, walls: GeoBuilder): RoofParts {
  const f = frame(spec)
  const y0 = spec.b.height
  const skin = new Geo(UV_M)
  const trim = new Geo(2)
  const oh = spec.overhang
  const a0 = f.a0 - (f.frontEnd === -1 ? 0 : oh)
  const a1 = f.a1 + (f.frontEnd === 1 ? 0 : oh)
  const span = (f.c1 - f.c0) / spec.bays
  const half = span / 2
  const slope = spec.rise / half
  const T = f.toWorld
  for (let k = 0; k < spec.bays; k++) {
    const cb0 = f.c0 + k * span
    const cb1 = cb0 + span
    const cm = cb0 + half
    // outer eaves overhang; the valley between bays doesn't
    const e0 = k === 0 ? cb0 - oh : cb0
    const e1 = k === spec.bays - 1 ? cb1 + oh : cb1
    const ye0 = y0 - (cb0 - e0) * slope
    const ye1 = y0 - (e1 - cb1) * slope
    const yr = y0 + spec.rise
    const s0 = Math.hypot(cm - e0, yr - ye0)
    const s1 = Math.hypot(e1 - cm, yr - ye1)
    // the two slopes, wound to face up
    skinQuad(
      skin,
      [T(a0, ye0, e0), T(a0, yr, cm), T(a1, yr, cm), T(a1, ye0, e0)],
      [a0, s0, a0, 0, a1, 0, a1, s0],
      spec.color,
    )
    skinQuad(
      skin,
      [T(a1, ye1, e1), T(a1, yr, cm), T(a0, yr, cm), T(a0, ye1, e1)],
      [a1, s1, a1, 0, a0, 0, a0, s1],
      spec.color,
    )
    // ridge cap (boards over shingles, flashing over tin)
    const cap = T((a0 + a1) / 2, yr + 0.035, cm)
    const capW = spec.skin === 'tin' ? 0.32 : 0.42
    const capH = spec.skin === 'tin' ? 0.07 : 0.13
    const capColor = spec.skin === 'tin' ? lighten(spec.color, 1.12) : spec.trim
    const len = a1 - a0 + 0.06
    ;(spec.skin === 'tin' ? skin : trim).box(
      cap.x,
      cap.y,
      cap.z,
      spec.axis === 'x' ? len : capW,
      capH,
      spec.axis === 'x' ? capW : len,
      capColor,
      { skip: ['bottom'] },
    )
    // fascia boards along the outer eaves
    for (const [e, ye, outer] of [
      [e0, ye0, k === 0],
      [e1, ye1, k === spec.bays - 1],
    ] as const) {
      if (!outer) {
        continue
      }
      const m = T((a0 + a1) / 2, ye - 0.09, e)
      trim.box(
        m.x,
        m.y,
        m.z,
        spec.axis === 'x' ? len : 0.07,
        0.22,
        spec.axis === 'x' ? 0.07 : len,
        spec.trim,
        {
          skip: ['bottom'],
        },
      )
    }
    // soffits: the underside of every overhang (the skin faces up only, so from the street the
    // eaves were see-through); a shade darker than the trim, a few centimetres under the skin
    const soffit = lighten(spec.trim, 0.55)
    const under = 0.04
    for (const [e, ye, cb, outer] of [
      [e0, ye0, cb0, k === 0],
      [e1, ye1, cb1, k === spec.bays - 1],
    ] as const) {
      if (!outer) {
        continue
      }
      const q = facing(
        [T(a0, ye - under, e), T(a1, ye - under, e), T(a1, y0 - under, cb), T(a0, y0 - under, cb)],
        (n) => n.y < 0,
      )
      trim.quad(q[0], q[1], q[2], q[3], soffit)
    }
    for (const end of [-1, 1] as const) {
      if (end === f.frontEnd) {
        continue
      }
      const a = end === -1 ? a0 : a1
      const aw = end === -1 ? f.a0 : f.a1
      // from the wall line up to the ridge (the eave soffit already covers the corner)
      for (const cb of [cb0, cb1]) {
        const q = facing(
          [
            T(a, y0 - under, cb),
            T(aw, y0 - under, cb),
            T(aw, yr - under, cm),
            T(a, yr - under, cm),
          ],
          (n) => n.y < 0,
        )
        trim.quad(q[0], q[1], q[2], q[3], soffit)
      }
    }
    // barge boards up the rakes, and the gable-end walls
    for (const end of [-1, 1] as const) {
      if (end === f.frontEnd) {
        continue
      }
      const a = end === -1 ? a0 : a1
      const inward = end === -1 ? 0.24 : -0.24
      const lift = 0.025
      for (const [e, ye] of [
        [e0, ye0],
        [e1, ye1],
      ] as const) {
        const top = facing(
          [
            T(a, ye + lift, e),
            T(a, yr + lift, cm),
            T(a + inward, yr + lift, cm),
            T(a + inward, ye + lift, e),
          ],
          (n) => n.y > 0,
        )
        trim.quad(top[0], top[1], top[2], top[3], spec.trim)
        // the board's outer edge, so it reads with thickness from the street
        const out = facing(
          [T(a, ye - 0.16, e), T(a, yr - 0.16, cm), T(a, yr + lift, cm), T(a, ye + lift, e)],
          (n) => outward(n, end, spec.axis),
        )
        trim.quad(out[0], out[1], out[2], out[3], spec.trim)
      }
      // gable wall: the building's end wall up to the ridge (wall paint)
      const aw = end === -1 ? f.a0 : f.a1
      const [g0, g1, g2] = facing([T(aw, y0, cb0), T(aw, y0, cb1), T(aw, yr, cm)], (n) =>
        outward(n, end, spec.axis),
      )
      walls.tri(g0, g1, g2, spec.wallColor)
    }
  }
  const sg = skin.build()
  const tg = trim.build()
  tag(sg, spec.skin === 'tin' ? RK_TIN : RK_SHINGLE)
  // the tin ridge flashing went into the skin builder; the trim is plain boards
  tag(tg, RK_PLAIN)
  const geometry = mergeTwo(sg, tg)
  return {
    geometry,
    heightAt: (x, z) => {
      const c = spec.axis === 'x' ? z : x
      const k = Math.min(spec.bays - 1, Math.max(0, Math.floor((c - f.c0) / span)))
      const cm = f.c0 + k * span + half
      return y0 + spec.rise - Math.abs(c - cm) * slope
    },
  }
}

/** The polygon wound so its normal passes `want` (reversed otherwise). */
function facing<T extends [Vector3, Vector3, Vector3, ...Vector3[]]>(
  p: T,
  want: (n: Vector3) => boolean,
): T {
  const a = p[0]
  const b = p[1]
  const c = p[2]
  const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a))
  return (want(n) ? p : [p[0], ...p.slice(1).reverse()]) as T
}

const outward = (n: Vector3, end: -1 | 1, axis: 'x' | 'z'): boolean =>
  (axis === 'x' ? n.x : n.z) * end > 0

function lighten(hex: number, k: number): number {
  const ch = (shift: number) => Math.min(255, Math.round(((hex >> shift) & 255) * k))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function tag(g: BufferGeometry, kind: number): void {
  g.setAttribute(
    'rk',
    new BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(kind), 1),
  )
}

function mergeTwo(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const out = a.clone()
  for (const name of Object.keys(a.attributes)) {
    const x = a.getAttribute(name)
    const y = b.getAttribute(name)
    const arr = new Float32Array(x.array.length + y.array.length)
    arr.set(x.array as Float32Array, 0)
    arr.set(y.array as Float32Array, x.array.length)
    out.setAttribute(name, new BufferAttribute(arr, x.itemSize))
  }
  out.computeBoundingSphere()
  return out
}

/** Which skin a building wears. */
export function roofSkin(kind: BuildingKind, id: number): RoofSkin {
  switch (kind) {
    case 'hotel':
    case 'assay':
    case 'stage_line':
    case 'bank':
    case 'jail':
    case 'depot':
    case 'smithy':
      return 'tin'
    case 'shed':
      return id % 2 === 0 ? 'tin' : 'shingle'
    default:
      return 'shingle'
  }
}

/** Tin colours: galvanised, red-painted, weathered green. */
const TIN = [0xb6_b4_ac, 0xb8_6c_50, 0x92_a2_8e] as const

export function tinColor(kind: BuildingKind, id: number): number {
  if (kind === 'bank' || kind === 'jail') {
    return TIN[0]
  }
  return TIN[id % TIN.length] ?? TIN[0]
}

/**
 * The roof material's skins: shingle courses (staggered tabs, butt shadows, per-shingle tone) and
 * corrugated tin (ribs down the slope, panel seams, rust streaks). Chain before `cutaway`.
 */
export function roofSkins(mat: MeshStandardMaterial): void {
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float rk;\nvarying float vRk;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRk = rk;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vRk;
float rHash(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.97))) * 15731.743); }
float rNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), f.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float rTin = 0.0;
if (vRk > 0.5) {
  vec2 ru = vMapUv * ${UV_M.toFixed(1)};
  // the planks' grain survives faintly; its mean (linear) keeps roofs as bright as before
  vec3 rMean = vec3(0.072, 0.047, 0.032);
  vec3 grain = mix(vec3(1.0), sampledDiffuseColor.rgb / rMean, 0.3);
  float aa = clamp(1.0 - fwidth(ru.y) * 3.0, 0.0, 1.0);
  if (vRk < 1.5) {
    float cH = 0.34;
    float row = floor(ru.y / cH);
    float t = fract(ru.y / cH);
    float w = 0.36 + 0.14 * rHash(vec2(row, 3.0));
    float off = rHash(vec2(row, 7.0)) * w;
    float col = floor((ru.x + off) / w);
    float tx = fract((ru.x + off) / w);
    float tone = rHash(vec2(col, row));
    float shade = mix(0.58, 1.0, smoothstep(0.0, 0.2, t)) * mix(1.0, 1.07, smoothstep(0.82, 1.0, t));
    shade *= mix(0.62, 1.0, smoothstep(0.0, 0.05, tx) * smoothstep(1.0, 0.95, tx));
    vec3 tint = mix(vec3(0.8, 0.78, 0.76), vec3(1.12, 1.05, 0.96), tone);
    tint *= mix(1.0, 0.86, smoothstep(0.55, 0.9, rNoise(ru * vec2(0.5, 0.9))));
    // a touch brighter than the old boards: weathered cedar goes silver-brown in the sun
    diffuseColor.rgb = diffuse * rMean * 1.2 * grain * mix(vec3(0.92), tint * shade, aa);
  } else {
    rTin = 1.0;
    float rib = 0.5 + 0.5 * cos(ru.x * 6.2832 / 0.2);
    float panel = floor(ru.x / 0.84);
    float seam = smoothstep(0.0, 0.03, fract(ru.x / 0.84)) * smoothstep(1.0, 0.985, fract(ru.x / 0.84));
    float aaX = clamp(1.0 - fwidth(ru.x) * 5.0, 0.0, 1.0);
    float shade = mix(1.0, mix(0.7, 1.12, rib * rib), aaX) * mix(0.6, 1.0, seam);
    float rust = smoothstep(0.5, 0.85, rNoise(vec2(ru.x * 1.3, ru.y * 0.18) + panel * 3.1)) * smoothstep(0.2, 1.4, ru.y);
    vec3 metal = vec3(0.075) * mix(0.9, 1.08, rHash(vec2(panel, 1.0)));
    metal = mix(metal, vec3(0.085, 0.04, 0.02), rust * 0.75);
    diffuseColor.rgb = diffuse * metal * shade;
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, rTin);',
      )
      // the plank normal map would score board lines across shingles and tin: skins go without
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nif (vRk > 0.5) normal = nonPerturbedNormal;',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.25, rTin);',
      )
  }
  const key = mat.customProgramCacheKey()
  mat.customProgramCacheKey = () => `${key}-skins`
}
