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
  /** Character rim light: strength and colour (warm by day, cool at night). */
  rim: number
  rimColor: Color
}

interface Key
  extends Omit<Preset, 'sunColor' | 'hemiSky' | 'hemiGround' | 'fog' | 'zenith' | 'rimColor'> {
  at: number
  sunColor: number
  hemiSky: number
  hemiGround: number
  fog: number
  zenith: number
  rimColor: number
}

const KEYS: Key[] = [
  {
    // High noon: sun nearly overhead and hard, the street bouncing warm light
    // up into the facades, thin haze, deep blue overhead, bleached highlights.
    at: 0,
    sunElev: 80,
    sunAz: 25,
    sunColor: 0xff_f4_e0,
    sunIntensity: 4.8,
    hemiSky: 0xbf_d8_ff,
    hemiGround: 0xc8_95_5a,
    hemiIntensity: 2.6,
    fog: 0xea_dc_bc,
    fogNear: 117,
    fogFar: 433,
    zenith: 0x3f_7f_d6,
    sunGlow: 0.2,
    stars: 0,
    moon: 0,
    lanterns: 0,
    windows: 0,
    bloom: 0.55,
    grain: 0.045,
    saturation: 0.95,
    contrast: 1.0,
    lift: 0.04,
    shadowTint: [1.02, 1.0, 0.97],
    highTint: [1.07, 1.03, 0.94],
    exposure: 1.08,
    shimmer: 1,
    rim: 0.2,
    rimColor: 0xff_ec_c8,
  },
  {
    at: 0.25,
    sunElev: 34,
    sunAz: 20,
    sunColor: 0xff_d9_a0,
    sunIntensity: 3.0,
    hemiSky: 0xc8_d4_f0,
    hemiGround: 0xa0_78_4a,
    hemiIntensity: 1.6,
    fog: 0xe0_c0_90,
    fogNear: 55,
    fogFar: 210,
    zenith: 0x7a_a0_d0,
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
    rim: 0.25,
    rimColor: 0xff_d8_a0,
  },
  {
    at: 0.45,
    sunElev: 16,
    sunAz: 14,
    sunColor: 0xff_b0_66,
    sunIntensity: 2.9,
    hemiSky: 0xb0_b8_e0,
    hemiGround: 0x8a_5a_3a,
    hemiIntensity: 1.25,
    fog: 0xd9_8a_5a,
    fogNear: 50,
    fogFar: 200,
    zenith: 0x5a_78_b0,
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
    rim: 0.32,
    rimColor: 0xff_b0_70,
  },
  {
    at: 0.6,
    sunElev: 4,
    sunAz: 10,
    sunColor: 0xff_6a_3d,
    sunIntensity: 2.4,
    hemiSky: 0x8a_90_c0,
    hemiGround: 0x5a_3a_30,
    hemiIntensity: 1.0,
    fog: 0xc8_70_4a,
    fogNear: 40,
    fogFar: 180,
    zenith: 0x34_40_7a,
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
    rim: 0.38,
    rimColor: 0xff_8a_50,
  },
  {
    at: 0.75,
    sunElev: -6,
    sunAz: 10,
    sunColor: 0x9a_7a_ff,
    sunIntensity: 0.6,
    hemiSky: 0x5a_5a_8a,
    hemiGround: 0x2a_20_28,
    hemiIntensity: 0.8,
    fog: 0x4a_3a_50,
    fogNear: 35,
    fogFar: 150,
    zenith: 0x16_1c_3a,
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
    rim: 0.3,
    rimColor: 0xb0_90_ff,
  },
  {
    at: 0.88,
    sunElev: 42,
    sunAz: -140,
    sunColor: 0x9f_b4_ff,
    sunIntensity: 1.1,
    hemiSky: 0x5a_6a_a8,
    hemiGround: 0x1d_18_24,
    hemiIntensity: 1.2,
    fog: 0x1a_22_36,
    fogNear: 30,
    fogFar: 120,
    zenith: 0x07_0b_1c,
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
    rim: 0.32,
    rimColor: 0x8f_b0_ff,
  },
  {
    at: 1,
    sunElev: 55,
    sunAz: -150,
    sunColor: 0x9f_b4_ff,
    sunIntensity: 1.7,
    hemiSky: 0x5a_6a_a8,
    hemiGround: 0x1d_18_24,
    hemiIntensity: 1.35,
    fog: 0x14_1a_2c,
    fogNear: 28,
    fogFar: 115,
    zenith: 0x05_08_1a,
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
    rim: 0.34,
    rimColor: 0x8f_b0_ff,
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
  while (i < KEYS.length - 2 && (KEYS[i + 1] as Key).at < d) {
    i++
  }
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
    rim: lerp(a.rim, b.rim, t),
    rimColor: mixC(a.rimColor, b.rimColor, t),
  }
}
