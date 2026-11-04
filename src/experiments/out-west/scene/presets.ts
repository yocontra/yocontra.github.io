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
  /** Cumulus cover (0..1) and how much a cloud's shadow takes off the sun. */
  clouds: number
  cloudShadow: number
  /** Aerial perspective: haze density at the ground, per metre. */
  haze: number
  /** Screen-space sun shafts (high tier only). */
  rays: number
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
    // High noon: a hard, high sun, deep blue overhead bleaching to a dusty horizon, bright
    // cumulus whose shadows drift over the street; the fill is kept down so the shade has weight.
    at: 0,
    sunElev: 68,
    sunAz: 32,
    sunColor: 0xff_f2_de,
    sunIntensity: 4.6,
    hemiSky: 0xb8_d0_ff,
    hemiGround: 0xb8_86_52,
    hemiIntensity: 1.7,
    fog: 0xe2_d4_bc,
    fogNear: 240,
    fogFar: 640,
    zenith: 0x1e_5a_c4,
    sunGlow: 0.35,
    stars: 0,
    moon: 0,
    lanterns: 0,
    windows: 0,
    bloom: 0.5,
    grain: 0.04,
    saturation: 1.16,
    contrast: 1.16,
    lift: 0.0,
    shadowTint: [0.96, 0.99, 1.05],
    highTint: [1.06, 1.02, 0.94],
    exposure: 1.02,
    shimmer: 1,
    rim: 0.22,
    rimColor: 0xff_ec_c8,
    clouds: 0.4,
    cloudShadow: 0.42,
    haze: 0.0022,
    rays: 0.0,
  },
  {
    // mid-afternoon: the light warming and lowering, shadows stretching out
    at: 0.25,
    sunElev: 30,
    sunAz: 22,
    sunColor: 0xff_d8_a2,
    sunIntensity: 4.0,
    hemiSky: 0xae_c4_f2,
    hemiGround: 0x9a_6e_42,
    hemiIntensity: 1.15,
    fog: 0xde_c2_9a,
    fogNear: 220,
    fogFar: 600,
    zenith: 0x3a_70_c8,
    sunGlow: 0.55,
    stars: 0,
    moon: 0,
    lanterns: 0,
    windows: 0,
    bloom: 0.6,
    grain: 0.045,
    saturation: 1.16,
    contrast: 1.16,
    lift: 0.0,
    shadowTint: [0.93, 0.98, 1.08],
    highTint: [1.08, 1.0, 0.88],
    exposure: 1.0,
    shimmer: 0.4,
    rim: 0.3,
    rimColor: 0xff_d4_9a,
    clouds: 0.46,
    cloudShadow: 0.4,
    haze: 0.0028,
    rays: 0.25,
  },
  {
    // golden hour: a low, amber key raking down the street, long shadows, a cool blue sky fill
    at: 0.45,
    sunElev: 11,
    sunAz: 12,
    sunColor: 0xff_a8_58,
    sunIntensity: 3.8,
    hemiSky: 0x8e_a6_e0,
    hemiGround: 0x6a_42_2c,
    hemiIntensity: 0.85,
    fog: 0xe0_9a_62,
    fogNear: 200,
    fogFar: 560,
    zenith: 0x3c_62_b0,
    sunGlow: 0.95,
    stars: 0,
    moon: 0,
    lanterns: 0.1,
    windows: 0.2,
    bloom: 0.75,
    grain: 0.05,
    saturation: 1.12,
    contrast: 1.18,
    lift: 0.0,
    shadowTint: [0.84, 0.95, 1.14],
    highTint: [1.12, 0.98, 0.84],
    exposure: 1.02,
    shimmer: 0,
    rim: 0.5,
    rimColor: 0xff_a4_60,
    clouds: 0.52,
    cloudShadow: 0.32,
    haze: 0.0036,
    rays: 0.55,
  },
  {
    // sunset: the disc on the horizon behind the courthouse, a red-orange key, violet shadows,
    // the first lamps lit
    at: 0.6,
    sunElev: 3,
    sunAz: 8,
    sunColor: 0xff_6a_32,
    sunIntensity: 3.0,
    hemiSky: 0x6e_7c_c4,
    hemiGround: 0x4a_2c_26,
    hemiIntensity: 0.8,
    fog: 0xd0_6e_48,
    fogNear: 180,
    fogFar: 520,
    zenith: 0x28_34_74,
    sunGlow: 1.25,
    stars: 0,
    moon: 0,
    lanterns: 0.45,
    windows: 0.55,
    bloom: 0.85,
    grain: 0.055,
    saturation: 1.08,
    contrast: 1.16,
    lift: 0.0,
    shadowTint: [0.8, 0.9, 1.16],
    highTint: [1.14, 0.96, 0.8],
    exposure: 1.08,
    shimmer: 0,
    rim: 0.58,
    rimColor: 0xff_7a_44,
    clouds: 0.55,
    cloudShadow: 0.2,
    haze: 0.0042,
    rays: 0.8,
  },
  {
    // dusk, the blue hour: the sun gone, the sky still glowing, every lamp and window warm
    at: 0.75,
    sunElev: -5,
    sunAz: 8,
    sunColor: 0x8a_74_e0,
    sunIntensity: 0.55,
    hemiSky: 0x4a_5a_9c,
    hemiGround: 0x1e_18_22,
    hemiIntensity: 0.9,
    fog: 0x4a_3a_5a,
    fogNear: 160,
    fogFar: 480,
    zenith: 0x12_18_3c,
    sunGlow: 0.6,
    stars: 0.45,
    moon: 0.4,
    lanterns: 1,
    windows: 1,
    bloom: 0.9,
    grain: 0.065,
    saturation: 0.92,
    contrast: 1.12,
    lift: 0.0,
    shadowTint: [0.84, 0.9, 1.16],
    highTint: [1.12, 0.96, 0.84],
    exposure: 1.18,
    shimmer: 0,
    rim: 0.5,
    rimColor: 0xa8_9c_ff,
    clouds: 0.4,
    cloudShadow: 0.0,
    haze: 0.004,
    rays: 0.0,
  },
  {
    // night: a cold moon high in the south, stars, the street a dark blue lit by warm pools
    at: 0.88,
    sunElev: 42,
    sunAz: -140,
    sunColor: 0x9c_b4_ff,
    sunIntensity: 1.25,
    hemiSky: 0x3e_50_90,
    hemiGround: 0x10_0e_16,
    hemiIntensity: 0.75,
    fog: 0x16_1e_34,
    fogNear: 150,
    fogFar: 420,
    zenith: 0x04_08_18,
    sunGlow: 0.0,
    stars: 1,
    moon: 1,
    lanterns: 1,
    windows: 1,
    bloom: 0.95,
    grain: 0.075,
    saturation: 0.78,
    contrast: 1.14,
    lift: 0.0,
    shadowTint: [0.84, 0.94, 1.18],
    highTint: [1.12, 0.98, 0.86],
    exposure: 1.32,
    shimmer: 0,
    rim: 0.55,
    rimColor: 0x8c_ac_ff,
    clouds: 0.3,
    cloudShadow: 0.0,
    haze: 0.0035,
    rays: 0.0,
  },
  {
    at: 1,
    sunElev: 52,
    sunAz: -150,
    sunColor: 0x9c_b4_ff,
    sunIntensity: 1.5,
    hemiSky: 0x3e_50_90,
    hemiGround: 0x10_0e_16,
    hemiIntensity: 0.8,
    fog: 0x12_1a_2e,
    fogNear: 150,
    fogFar: 420,
    zenith: 0x03_06_14,
    sunGlow: 0.0,
    stars: 1,
    moon: 1,
    lanterns: 1,
    windows: 1,
    bloom: 1.0,
    grain: 0.075,
    saturation: 0.74,
    contrast: 1.15,
    lift: 0.0,
    shadowTint: [0.84, 0.94, 1.2],
    highTint: [1.14, 0.98, 0.84],
    exposure: 1.34,
    shimmer: 0,
    rim: 0.58,
    rimColor: 0x8c_ac_ff,
    clouds: 0.28,
    cloudShadow: 0.0,
    haze: 0.0035,
    rays: 0.0,
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
    clouds: lerp(a.clouds, b.clouds, t),
    cloudShadow: lerp(a.cloudShadow, b.cloudShadow, t),
    haze: lerp(a.haze, b.haze, t),
    rays: lerp(a.rays, b.rays, t),
  }
}
