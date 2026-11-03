import { Color } from 'three'

/** Time-of-day lighting (design doc §4.1). Keyframes on a 0 (noon) .. 1 (midnight) scalar. */
export interface Preset {
  sunElev: number
  sunAz: number
  sunColor: Color
  sunIntensity: number
  hemiSky: Color
  hemiGround: Color
  hemiIntensity: number
  fog: Color
  fogNear: number
  fogFar: number
  zenith: Color
  sunGlow: number
  stars: number
  moon: number
  lanterns: number
  windows: number
  bloom: number
  grain: number
  saturation: number
  contrast: number
  lift: number
  shadowTint: [number, number, number]
  highTint: [number, number, number]
  exposure: number
  shimmer: number
}

interface Key extends Omit<Preset, 'sunColor' | 'hemiSky' | 'hemiGround' | 'fog' | 'zenith'> {
  at: number
  sunColor: number
  hemiSky: number
  hemiGround: number
  fog: number
  zenith: number
}

const KEYS: Key[] = [
  {
    at: 0,
    sunElev: 72,
    sunAz: 25,
    sunColor: 0xfff1d6,
    sunIntensity: 3.2,
    hemiSky: 0xcfe0ff,
    hemiGround: 0xb08a5a,
    hemiIntensity: 1.9,
    fog: 0xe8d3a8,
    fogNear: 70,
    fogFar: 260,
    zenith: 0x6f9fd8,
    sunGlow: 0.25,
    stars: 0,
    moon: 0,
    lanterns: 0,
    windows: 0,
    bloom: 0.6,
    grain: 0.05,
    saturation: 0.86,
    contrast: 1.04,
    lift: 0.025,
    shadowTint: [1.0, 0.97, 0.92],
    highTint: [1.06, 1.0, 0.9],
    exposure: 1.0,
    shimmer: 1,
  },
  {
    at: 0.25,
    sunElev: 34,
    sunAz: 20,
    sunColor: 0xffd9a0,
    sunIntensity: 3.0,
    hemiSky: 0xc8d4f0,
    hemiGround: 0xa0784a,
    hemiIntensity: 1.6,
    fog: 0xe0c090,
    fogNear: 55,
    fogFar: 210,
    zenith: 0x7aa0d0,
    sunGlow: 0.35,
    stars: 0,
    moon: 0,
    lanterns: 0,
    windows: 0,
    bloom: 0.65,
    grain: 0.05,
    saturation: 0.95,
    contrast: 1.06,
    lift: 0.015,
    shadowTint: [0.97, 0.98, 1.0],
    highTint: [1.08, 1.0, 0.88],
    exposure: 1.0,
    shimmer: 0.4,
  },
  {
    at: 0.45,
    sunElev: 16,
    sunAz: 14,
    sunColor: 0xffb066,
    sunIntensity: 2.9,
    hemiSky: 0xb0b8e0,
    hemiGround: 0x8a5a3a,
    hemiIntensity: 1.25,
    fog: 0xd98a5a,
    fogNear: 50,
    fogFar: 200,
    zenith: 0x5a78b0,
    sunGlow: 0.7,
    stars: 0,
    moon: 0,
    lanterns: 0,
    windows: 0.1,
    bloom: 0.7,
    grain: 0.055,
    saturation: 1.05,
    contrast: 1.08,
    lift: 0.01,
    shadowTint: [0.88, 0.98, 1.06],
    highTint: [1.1, 0.98, 0.85],
    exposure: 1.0,
    shimmer: 0,
  },
  {
    at: 0.6,
    sunElev: 4,
    sunAz: 10,
    sunColor: 0xff6a3d,
    sunIntensity: 2.4,
    hemiSky: 0x8a90c0,
    hemiGround: 0x5a3a30,
    hemiIntensity: 1.0,
    fog: 0xc8704a,
    fogNear: 40,
    fogFar: 180,
    zenith: 0x34407a,
    sunGlow: 1.0,
    stars: 0,
    moon: 0,
    lanterns: 0.3,
    windows: 0.4,
    bloom: 0.75,
    grain: 0.06,
    saturation: 1.08,
    contrast: 1.1,
    lift: 0.0,
    shadowTint: [0.8, 0.96, 1.08],
    highTint: [1.14, 0.96, 0.8],
    exposure: 1.05,
    shimmer: 0,
  },
  {
    at: 0.75,
    sunElev: -6,
    sunAz: 10,
    sunColor: 0x9a7aff,
    sunIntensity: 0.6,
    hemiSky: 0x5a5a8a,
    hemiGround: 0x2a2028,
    hemiIntensity: 0.8,
    fog: 0x4a3a50,
    fogNear: 35,
    fogFar: 150,
    zenith: 0x161c3a,
    sunGlow: 0.5,
    stars: 0.4,
    moon: 0.4,
    lanterns: 0.8,
    windows: 0.8,
    bloom: 0.8,
    grain: 0.07,
    saturation: 0.85,
    contrast: 1.08,
    lift: 0.0,
    shadowTint: [0.85, 0.92, 1.12],
    highTint: [1.1, 0.95, 0.85],
    exposure: 1.1,
    shimmer: 0,
  },
  {
    at: 0.88,
    sunElev: 42,
    sunAz: -140,
    sunColor: 0x9fb4ff,
    sunIntensity: 1.1,
    hemiSky: 0x5a6aa8,
    hemiGround: 0x1d1824,
    hemiIntensity: 1.2,
    fog: 0x1a2236,
    fogNear: 30,
    fogFar: 120,
    zenith: 0x070b1c,
    sunGlow: 0.0,
    stars: 1,
    moon: 1,
    lanterns: 1,
    windows: 1,
    bloom: 0.9,
    grain: 0.08,
    saturation: 0.72,
    contrast: 1.1,
    lift: 0.0,
    shadowTint: [0.85, 0.95, 1.15],
    highTint: [1.12, 0.98, 0.85],
    exposure: 1.5,
    shimmer: 0,
  },
  {
    at: 1,
    sunElev: 55,
    sunAz: -150,
    sunColor: 0x9fb4ff,
    sunIntensity: 1.7,
    hemiSky: 0x5a6aa8,
    hemiGround: 0x1d1824,
    hemiIntensity: 1.35,
    fog: 0x141a2c,
    fogNear: 28,
    fogFar: 115,
    zenith: 0x05081a,
    sunGlow: 0.0,
    stars: 1,
    moon: 1,
    lanterns: 1,
    windows: 1,
    bloom: 0.95,
    grain: 0.08,
    saturation: 0.68,
    contrast: 1.12,
    lift: 0.0,
    shadowTint: [0.85, 0.95, 1.18],
    highTint: [1.14, 0.98, 0.84],
    exposure: 1.5,
    shimmer: 0,
  },
]

const ca = new Color()
const cb = new Color()

function mixC(a: number, b: number, t: number): Color {
  return ca.set(a).lerp(cb.set(b), t).clone()
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerp3 = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

export function presetAt(day: number): Preset {
  const d = Math.min(1, Math.max(0, day))
  let i = 0
  while (i < KEYS.length - 2 && (KEYS[i + 1] as Key).at < d) i++
  const a = KEYS[i] as Key
  const b = KEYS[i + 1] as Key
  const t0 = (d - a.at) / Math.max(1e-6, b.at - a.at)
  const t = t0 * t0 * (3 - 2 * t0)
  return {
    sunElev: lerp(a.sunElev, b.sunElev, t),
    sunAz: lerp(a.sunAz, b.sunAz, t),
    sunColor: mixC(a.sunColor, b.sunColor, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    hemiSky: mixC(a.hemiSky, b.hemiSky, t),
    hemiGround: mixC(a.hemiGround, b.hemiGround, t),
    hemiIntensity: lerp(a.hemiIntensity, b.hemiIntensity, t),
    fog: mixC(a.fog, b.fog, t),
    fogNear: lerp(a.fogNear, b.fogNear, t),
    fogFar: lerp(a.fogFar, b.fogFar, t),
    zenith: mixC(a.zenith, b.zenith, t),
    sunGlow: lerp(a.sunGlow, b.sunGlow, t),
    stars: lerp(a.stars, b.stars, t),
    moon: lerp(a.moon, b.moon, t),
    lanterns: lerp(a.lanterns, b.lanterns, t),
    windows: lerp(a.windows, b.windows, t),
    bloom: lerp(a.bloom, b.bloom, t),
    grain: lerp(a.grain, b.grain, t),
    saturation: lerp(a.saturation, b.saturation, t),
    contrast: lerp(a.contrast, b.contrast, t),
    lift: lerp(a.lift, b.lift, t),
    shadowTint: lerp3(a.shadowTint, b.shadowTint, t),
    highTint: lerp3(a.highTint, b.highTint, t),
    exposure: lerp(a.exposure, b.exposure, t),
    shimmer: lerp(a.shimmer, b.shimmer, t),
  }
}
