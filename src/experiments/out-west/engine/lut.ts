/**
 * 32³ colour-grading LUTs, one per time-of-day key (design doc §9.5 item 5).
 *
 * The parametric grade in render.ts stays live (the director animates
 * saturation, flashes and exposure per moment). The LUT carries the *look*:
 * split toning, a filmic toe and shoulder, and hue-selective moves a slider
 * grade can't do (teal skies, warm skin, dusty greens). Each LUT is generated
 * here from a small recipe, so nothing is downloaded. An authored `.cube` from
 * Resolve can replace a recipe later through `lutFromCube`.
 */
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  UnsignedByteType,
} from 'three'

export const LUT_SIZE = 32

export interface Look {
  /** Day position this recipe belongs to (matches presets.ts keys). */
  at: number
  /** Shadow and highlight tints (RGB multipliers around 1). */
  shadows: [number, number, number]
  highlights: [number, number, number]
  /** Toe/shoulder S-curve strength, 0..1. */
  curve: number
  /** Black-point lift (faded film) and white roll-off. */
  fade: number
  /** Blue/cyan hues pushed toward teal, 0..1. */
  tealSky: number
  /** Orange/red hue saturation boost (skin, adobe, sunset). */
  warmSat: number
  /** Green hues desaturated toward dust. */
  dustGreens: number
  /** Overall saturation multiplier applied last. */
  sat: number
}

export const LOOKS: readonly Look[] = [
  {
    // noon: bleached, warm highlights, faintly cool shadows
    at: 0,
    shadows: [0.97, 1.0, 1.04],
    highlights: [1.04, 1.01, 0.95],
    curve: 0.35,
    fade: 0.015,
    tealSky: 0.35,
    warmSat: 0.12,
    dustGreens: 0.5,
    sat: 1.02,
  },
  {
    at: 0.25,
    shadows: [0.95, 0.99, 1.06],
    highlights: [1.05, 1.0, 0.92],
    curve: 0.45,
    fade: 0.01,
    tealSky: 0.45,
    warmSat: 0.18,
    dustGreens: 0.5,
    sat: 1.04,
  },
  {
    // golden hour: orange and teal
    at: 0.45,
    shadows: [0.9, 0.99, 1.1],
    highlights: [1.08, 0.99, 0.86],
    curve: 0.55,
    fade: 0.01,
    tealSky: 0.6,
    warmSat: 0.25,
    dustGreens: 0.55,
    sat: 1.06,
  },
  {
    // sunset: deep magenta-red sky, violet shadows
    at: 0.6,
    shadows: [0.94, 0.92, 1.12],
    highlights: [1.1, 0.97, 0.84],
    curve: 0.6,
    fade: 0.0,
    tealSky: 0.3,
    warmSat: 0.3,
    dustGreens: 0.6,
    sat: 1.06,
  },
  {
    at: 0.75,
    shadows: [0.92, 0.94, 1.14],
    highlights: [1.1, 0.98, 0.86],
    curve: 0.5,
    fade: 0.02,
    tealSky: 0.2,
    warmSat: 0.2,
    dustGreens: 0.6,
    sat: 0.98,
  },
  {
    // night: moonlit blue world, lantern light stays warm
    at: 0.88,
    shadows: [0.9, 0.96, 1.16],
    highlights: [1.12, 1.0, 0.86],
    curve: 0.5,
    fade: 0.025,
    tealSky: 0.15,
    warmSat: 0.25,
    dustGreens: 0.7,
    sat: 0.95,
  },
  {
    at: 1,
    shadows: [0.9, 0.96, 1.18],
    highlights: [1.12, 1.0, 0.85],
    curve: 0.5,
    fade: 0.03,
    tealSky: 0.15,
    warmSat: 0.25,
    dustGreens: 0.7,
    sat: 0.95,
  },
]

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function rgb2hsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d > 1e-6) {
    if (mx === r) {
      h = ((g - b) / d + 6) % 6
    } else if (mx === g) {
      h = (b - r) / d + 2
    } else {
      h = (r - g) / d + 4
    }
    h /= 6
  }
  return [h, mx > 0 ? d / mx : 0, mx]
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  const k = ((i % 6) + 6) % 6
  const table: [number, number, number][] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ]
  return table[k] ?? [v, v, v]
}

/** Weight of hue h within a band centred at c (all in 0..1 turns). */
function hueBand(h: number, c: number, width: number): number {
  let d = Math.abs(h - c)
  d = Math.min(d, 1 - d)
  return 1 - smooth(width * 0.5, width, d)
}

/** Apply a look to one display-referred colour (sRGB-encoded 0..1 in, out). */
export function applyLook(
  look: Look,
  r0: number,
  g0: number,
  b0: number,
): [number, number, number] {
  let r = r0
  let g = g0
  let b = b0
  // split toning by luma
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const hi = smooth(0.25, 0.85, l)
  r *= look.shadows[0] + (look.highlights[0] - look.shadows[0]) * hi
  g *= look.shadows[1] + (look.highlights[1] - look.shadows[1]) * hi
  b *= look.shadows[2] + (look.highlights[2] - look.shadows[2]) * hi
  // hue-selective moves
  let [h, s, v] = rgb2hsv(clamp01(r), clamp01(g), clamp01(b))
  const sky = hueBand(h, 0.58, 0.14) * look.tealSky
  h += (0.52 - h) * sky * 0.5
  s *= 1 + sky * 0.08
  const warm = hueBand(h, 0.06, 0.12) * look.warmSat
  s *= 1 + warm
  const green = hueBand(h, 0.3, 0.16) * look.dustGreens
  h += (0.16 - h) * green * 0.3
  s *= 1 - green * 0.45
  ;[r, g, b] = hsv2rgb(((h % 1) + 1) % 1, clamp01(s), v)
  // filmic S-curve (toe + shoulder) around mid-grey
  const curve = (x: number) => {
    const sx = x * x * (3 - 2 * x)
    return x + (sx - x) * look.curve
  }
  r = curve(clamp01(r))
  g = curve(clamp01(g))
  b = curve(clamp01(b))
  // fade
  r = look.fade + r * (1 - look.fade)
  g = look.fade + g * (1 - look.fade)
  b = look.fade + b * (1 - look.fade * 0.6)
  // global saturation
  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b
  r = l2 + (r - l2) * look.sat
  g = l2 + (g - l2) * look.sat
  b = l2 + (b - l2) * look.sat
  return [clamp01(r), clamp01(g), clamp01(b)]
}

/** Raw RGBA8 data for a look (also used by tools/make-luts.ts to write .cube files). */
export function lookData(look: Look, n = LUT_SIZE): Uint8Array {
  const data = new Uint8Array(n * n * n * 4)
  let o = 0
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const [r, g, b] = applyLook(look, x / (n - 1), y / (n - 1), z / (n - 1))
        data[o++] = Math.round(r * 255)
        data[o++] = Math.round(g * 255)
        data[o++] = Math.round(b * 255)
        data[o++] = 255
      }
    }
  }
  return data
}

function toTexture(data: Uint8Array, n: number): Data3DTexture {
  const t = new Data3DTexture(data, n, n, n)
  t.type = UnsignedByteType
  t.minFilter = LinearFilter
  t.magFilter = LinearFilter
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.wrapR = ClampToEdgeWrapping
  t.generateMipmaps = false
  t.unpackAlignment = 1
  t.colorSpace = LinearSRGBColorSpace
  t.needsUpdate = true
  return t
}

const cache = new Map<number, Data3DTexture>()

export function lutTexture(look: Look): Data3DTexture {
  const have = cache.get(look.at)
  if (have) {
    return have
  }
  const t = toTexture(lookData(look), LUT_SIZE)
  cache.set(look.at, t)
  return t
}

/** The two LUTs that bracket `day`, and the blend between them. */
export function lutsAt(day: number): { a: Data3DTexture; b: Data3DTexture; t: number } {
  const d = clamp01(day)
  let i = 0
  while (i < LOOKS.length - 2 && (LOOKS[i + 1] as Look).at < d) {
    i++
  }
  const la = LOOKS[i] as Look
  const lb = LOOKS[i + 1] as Look
  const t = clamp01((d - la.at) / Math.max(1e-6, lb.at - la.at))
  return { a: lutTexture(la), b: lutTexture(lb), t: t * t * (3 - 2 * t) }
}

const WS = /\s+/u
const NUMERIC = /^[\d.-]/u

/** Parse an authored Resolve/Photoshop `.cube` (3D, any size) into a LUT texture. */
export function lutFromCube(text: string): Data3DTexture {
  let n = 0
  const values: number[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s.startsWith('LUT_3D_SIZE')) {
      n = Number(s.split(WS)[1])
    } else if (NUMERIC.test(s)) {
      for (const v of s.split(WS)) {
        values.push(Number(v))
      }
    }
  }
  const data = new Uint8Array(n * n * n * 4)
  for (let k = 0; k < n * n * n; k++) {
    data[k * 4] = Math.round(clamp01(values[k * 3] ?? 0) * 255)
    data[k * 4 + 1] = Math.round(clamp01(values[k * 3 + 1] ?? 0) * 255)
    data[k * 4 + 2] = Math.round(clamp01(values[k * 3 + 2] ?? 0) * 255)
    data[k * 4 + 3] = 255
  }
  return toTexture(data, n)
}
