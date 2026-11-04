// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: flat loops over rings and texels
// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numbers, like three.js
// biome-ignore-all lint/style/noMagicNumbers: a gunsmith's measurements and a texture's colours
/**
 * The long guns' workshop: one small procedural texture, one material and the geometry helpers
 * the Winchester (`scene/rifle.ts`) and the coach gun (`ffa/scene/shotgun.ts`) are built with.
 *
 * - The texture (`gunTexture`) is four bands, generated once in code (no file): oiled walnut with
 *   its grain running along the gun, blued steel with fine polishing lines, case-hardened colour
 *   (the straw, blue and plum mottle of a Winchester's or a coach gun's receiver), and brass.
 * - The material (`gunMaterial`) is ONE MeshStandardMaterial for every long gun (one program,
 *   one draw per gun): its metalness and roughness come per vertex (the `pbr` attribute), so
 *   blued steel, brass and walnut each get their own finish inside one mesh; a metal mirrors the
 *   sky's brightness more than its colour (as the revolver's steel does, engine/assets.ts).
 * - The helpers place a three.js primitive, a loft or a swept tube and give it a finish: UVs on
 *   its band (U along the gun, so the grain and the polishing run lengthwise), a tint and a PBR
 *   pair. `forge` merges the parts and rounds their normals with a crease angle.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  ClampToEdgeWrapping,
  DataTexture,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { creaseNormals } from './normals.ts'

const TEX_W = 512
const BAND_H = 128
const BANDS = 4
const TEX_H = BAND_H * BANDS

type Rgb = readonly [number, number, number]

/** A surface: its texture band, a tint over it, and its metalness and roughness. */
export interface Finish {
  band: 0 | 1 | 2 | 3
  rgb: Rgb
  metal: number
  rough: number
}

/** Oiled walnut: a satin sheen, not a varnish. */
export const WALNUT: Finish = { band: 0, rgb: [1, 1, 1], metal: 0, rough: 0.52 }
/** Blued steel, the barrel and the small parts (the bluing is an oxide: a touch of diffuse). */
export const BLUED: Finish = { band: 1, rgb: [1, 1, 1], metal: 0.9, rough: 0.4 }
/** Case-hardened iron, the receiver and the hammers: its colours are an oxide film, so part diffuse. */
export const CASE: Finish = { band: 2, rgb: [1, 1, 1], metal: 0.75, rough: 0.42 }
/** Brass (the Winchester's lifter, a bead). */
export const BRASS: Finish = { band: 3, rgb: [1, 1, 1], metal: 1, rough: 0.32 }
/** The dark of a bore or a slot. */
export const BORE: Finish = { band: 1, rgb: [0.08, 0.08, 0.08], metal: 0, rough: 0.9 }

/** V inside a band, a tenth in from each edge (the mips never bleed a neighbour in). */
function bandV(band: number, t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return (band * BAND_H + BAND_H * (0.1 + 0.8 * c)) / TEX_H
}

// ---------------------------------------------------------------- the texture

const fract = (v: number): number => v - Math.floor(v)
const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const lerp3 = (a: Rgb, b: Rgb, t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
/** A stable random number per lattice point. */
const hash = (x: number, y: number, seed: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43_758.5453)
const fade = (t: number): number => t * t * (3 - 2 * t)
/**
 * Smooth value noise over the band, `fx` cells across the texture's width (it wraps there: the
 * gun's U repeats) and `fy` cells down a band.
 */
function noise(x: number, y: number, fx: number, fy: number, seed: number): number {
  const u = (x / TEX_W) * fx
  const v = (y / BAND_H) * fy
  const i = Math.floor(u)
  const j = Math.floor(v)
  const a = fade(u - i)
  const b = fade(v - j)
  const i0 = ((i % fx) + fx) % fx
  const i1 = (i0 + 1) % fx
  const h00 = hash(i0, j, seed)
  const h10 = hash(i1, j, seed)
  const h01 = hash(i0, j + 1, seed)
  const h11 = hash(i1, j + 1, seed)
  return h00 + (h10 - h00) * a + (h01 - h00) * b + (h00 - h10 - h01 + h11) * a * b
}
/** Three octaves of it, 0..1. */
function fbm(x: number, y: number, fx: number, fy: number, seed: number): number {
  return (
    noise(x, y, fx, fy, seed) * 0.55 +
    noise(x, y, fx * 2, fy * 2, seed + 1) * 0.3 +
    noise(x, y, fx * 4, fy * 4, seed + 2) * 0.15
  )
}

// American black walnut, oiled: a dark chocolate brown with lighter streaks of figure
const WALNUT_LIGHT: Rgb = [112, 72, 44]
const WALNUT_DARK: Rgb = [58, 36, 23]
const WALNUT_LINE: Rgb = [38, 23, 14]

function walnut(x: number, y: number): [number, number, number] {
  // the figure: long soft streaks along the grain
  const figure = fbm(x, y, 3, 5, 1)
  // the grain: fine dark lines along U, wandering across it
  const ring = fract((y / BAND_H) * 11 + fbm(x, y, 4, 2, 7) * 3.2)
  const line = 1 - smooth(0, 0.07, ring) * (1 - smooth(0.9, 1, ring))
  // pores: tiny dark flecks drawn out along the grain
  const pore = smooth(0.72, 0.9, noise(x, y, 160, 40, 13)) * 0.35
  const base = lerp3(WALNUT_DARK, WALNUT_LIGHT, smooth(0.25, 0.8, figure))
  return lerp3(base, WALNUT_LINE, Math.min(1, line * 0.45 + pore))
}

function blued(x: number, y: number): [number, number, number] {
  // blue-black, faint polishing lines along U and a little wear
  const lines = (noise(x, y, 8, 96, 5) - 0.5) * 9
  const wear = smooth(0.62, 0.9, fbm(x, y, 6, 3, 9)) * 14
  const v = lines + wear
  return [52 + v, 57 + v, 70 + v * 1.1]
}

// Case colours: the grey of the iron through soft swirls of blue, straw and plum, darkened
const CASE_GREY: Rgb = [92, 94, 98]
const CASE_HUES: readonly Rgb[] = [
  [40, 52, 86],
  [76, 88, 104],
  [140, 110, 66],
  [46, 46, 52],
  [58, 80, 98],
  [86, 64, 82],
]

function caseHardened(x: number, y: number): [number, number, number] {
  const pick = fbm(x, y, 7, 3, 21) * (CASE_HUES.length - 1)
  const i = Math.min(CASE_HUES.length - 2, Math.floor(pick))
  const c0 = CASE_HUES[i] ?? CASE_GREY
  const c1 = CASE_HUES[i + 1] ?? c0
  const hue = lerp3(c0, c1, smooth(0.15, 0.85, pick - i))
  // where the colour shows through the grey, and a little darker mottle over everything
  const show = smooth(0.38, 0.7, fbm(x, y, 9, 4, 33))
  const c = lerp3(CASE_GREY, hue, show * 0.85)
  const k = 0.9 + 0.14 * fbm(x, y, 24, 10, 41)
  return [c[0] * k, c[1] * k, c[2] * k]
}

function brass(x: number, y: number): [number, number, number] {
  // aged brass: warm, a little tarnish in soft patches, fine polishing lines
  const lines = (noise(x, y, 8, 96, 23) - 0.5) * 10
  const tarnish = smooth(0.5, 0.85, fbm(x, y, 5, 3, 27)) * 0.25
  const c = lerp3([212, 172, 98], [128, 96, 52], tarnish)
  return [c[0] + lines, c[1] + lines, c[2] + lines * 0.6]
}

const PAINT = [walnut, blued, caseHardened, brass] as const

let texture: DataTexture | null = null

/** The long guns' texture: walnut, blued steel, case colour, brass (built once). */
export function gunTexture(): DataTexture {
  if (texture) {
    return texture
  }
  const data = new Uint8Array(TEX_W * TEX_H * 4)
  for (let y = 0; y < TEX_H; y++) {
    const band = Math.floor(y / BAND_H)
    const paint = PAINT[band] ?? walnut
    const ly = y - band * BAND_H
    for (let x = 0; x < TEX_W; x++) {
      const c = paint(x, ly)
      const i = (y * TEX_W + x) * 4
      data[i] = Math.max(0, Math.min(255, c[0]))
      data[i + 1] = Math.max(0, Math.min(255, c[1]))
      data[i + 2] = Math.max(0, Math.min(255, c[2]))
      data[i + 3] = 255
    }
  }
  const t = new DataTexture(data, TEX_W, TEX_H)
  t.colorSpace = SRGBColorSpace
  t.wrapS = RepeatWrapping
  t.wrapT = ClampToEdgeWrapping
  t.minFilter = LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.name = 'gun-finish'
  t.needsUpdate = true
  texture = t
  return t
}

// ---------------------------------------------------------------- the material

let material: MeshStandardMaterial | null = null

/** The one material every long gun draws with (shared: never mutate it). */
export function gunMaterial(): MeshStandardMaterial {
  if (material) {
    return material
  }
  const m = new MeshStandardMaterial({
    name: 'GunLong',
    map: gunTexture(),
    vertexColors: true,
    roughness: 1,
    metalness: 1,
  })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 pbr;\nvarying vec2 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPbr;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.x;')
      // oiled steel and brass mirror the sky's brightness more than its blue
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
radiance = mix( vec3( dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ), radiance, mix( 1.0, 0.35, vPbr.x ) );`,
      )
  }
  m.customProgramCacheKey = () => 'ow-gun-long'
  material = m
  return m
}

// ---------------------------------------------------------------- geometry

const M = (): Matrix4 => new Matrix4()

/** A cylinder (three's along Y) laid along +X, centred at (x, y, z). */
export const alongX = (x: number, y: number, z: number): Matrix4 =>
  M()
    .makeRotationZ(-Math.PI / 2)
    .setPosition(x, y, z)

/** Translation. */
export const at = (x: number, y: number, z: number): Matrix4 => M().makeTranslation(x, y, z)

/** Give a placed primitive its finish: U along the gun (X), V around it from its own UVs. */
function dress(g: BufferGeometry, f: Finish, around: 'u' | 'v' | 'y'): BufferGeometry {
  const P = g.getAttribute('position')
  const T = g.getAttribute('uv')
  const n = P.count
  const uv = new Float32Array(n * 2)
  const col = new Float32Array(n * 3)
  const pbr = new Float32Array(n * 2)
  for (let k = 0; k < n; k++) {
    let t = 0.5
    if (around === 'u') {
      t = T ? T.getX(k) : 0.5
    } else if (around === 'v') {
      t = T ? T.getY(k) : 0.5
    } else {
      t = 0.5 + P.getY(k) * 6
    }
    uv[k * 2] = P.getX(k) * 2.2 + P.getZ(k) * 0.7
    uv[k * 2 + 1] = bandV(f.band, fract(t))
    col.set(f.rgb, k * 3)
    pbr[k * 2] = f.metal
    pbr[k * 2 + 1] = f.rough
  }
  const out = g
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal') {
      out.deleteAttribute(name)
    }
  }
  out.setAttribute('uv', new BufferAttribute(uv, 2))
  out.setAttribute('color', new BufferAttribute(col, 3))
  out.setAttribute('pbr', new BufferAttribute(pbr, 2))
  if (!out.getAttribute('normal')) {
    out.computeVertexNormals()
  }
  return out
}

/** A three.js primitive placed by `xf` and finished. */
export function part(
  g: BufferGeometry,
  xf: Matrix4,
  f: Finish,
  around: 'u' | 'v' | 'y' = 'u',
): BufferGeometry {
  g.applyMatrix4(xf)
  return dress(g, f, around)
}

/**
 * One loft section: x, the centre's height, the height and width of a rounded-rectangle section,
 * and how far the middle of the section bows forward along X (a crescent butt), 0 = flat.
 */
export type Section = readonly [x: number, cy: number, h: number, w: number, bow?: number]

/**
 * A tube along +X through rounded-rectangle sections, capped at both ends. `square` near 0 is a
 * box with rounded edges, 1 an ellipse.
 */
export function loft(
  sections: readonly Section[],
  f: Finish,
  o: { sides?: number; square?: number; caps?: boolean } = {},
): BufferGeometry {
  const sides = o.sides ?? 14
  const sq = o.square ?? 0.6
  const ring = sides + 1
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const shape = (v: number) => Math.sign(v) * Math.abs(v) ** sq
  for (const [x, cy, h, w, bow = 0] of sections) {
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2 + Math.PI / sides
      const s = shape(Math.sin(a))
      const c = shape(Math.cos(a))
      pos.push(x + bow * (1 - s * s), cy + (h / 2) * s, (w / 2) * c)
      uv.push(0, k / sides)
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * ring + k
      const b = a + ring
      idx.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  const body = new BufferGeometry()
  body.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  body.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  body.setIndex(idx)
  // round over the seam where the ring closes; the caps keep their own flat normals
  creaseNormals(body, 50)
  const geos = [dress(body, f, 'v')]
  if (o.caps !== false) {
    for (const end of [0, sections.length - 1]) {
      const sec = sections[end]
      if (!sec) {
        continue
      }
      const cp: number[] = [sec[0] + (sec[4] ?? 0), sec[1], 0]
      const ci: number[] = []
      for (let k = 0; k < sides; k++) {
        const p = (end * ring + k) * 3
        cp.push(pos[p] ?? 0, pos[p + 1] ?? 0, pos[p + 2] ?? 0)
      }
      for (let k = 0; k < sides; k++) {
        const a = 1 + k
        const b = 1 + ((k + 1) % sides)
        ci.push(...(end === 0 ? [0, a, b] : [0, b, a]))
      }
      const cap = new BufferGeometry()
      cap.setAttribute('position', new BufferAttribute(new Float32Array(cp), 3))
      cap.setIndex(ci)
      cap.computeVertexNormals()
      geos.push(dress(cap, f, 'y'))
    }
  }
  return mergeGeometries(geos, false) ?? geos[0] ?? body
}

/** A round tube swept through points (a lever, a ring), finished. */
export function sweep(
  points: readonly (readonly [number, number, number])[],
  r: number,
  f: Finish,
  o: { segments?: number; radial?: number; closed?: boolean; flat?: number } = {},
): BufferGeometry {
  const curve = new CatmullRomCurve3(
    points.map((p) => new Vector3(p[0], p[1], p[2])),
    o.closed ?? false,
    'centripetal',
  )
  const g = new TubeGeometry(curve, o.segments ?? 32, r, o.radial ?? 6, o.closed ?? false)
  if (o.flat) {
    // flatten across the gun (a lever is a flat bar with rounded edges, not a wire)
    const P = g.getAttribute('position')
    const z0 = points[0]?.[2] ?? 0
    for (let k = 0; k < P.count; k++) {
      P.setZ(k, z0 + (P.getZ(k) - z0) * o.flat)
    }
  }
  // round over the seam where the tube's ring closes
  creaseNormals(g, 60)
  return dress(g, f, 'u')
}

/** Merge finished parts (each keeps the normals it was made with) into one geometry. */
export function forge(parts: readonly BufferGeometry[]): BufferGeometry {
  const geo = mergeGeometries([...parts], false)
  if (!geo) {
    throw new Error('gunsmith: merge failed')
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}
