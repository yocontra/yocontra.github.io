export interface HeroParams {
  /** Animation speed multiplier. */
  speed: number
  /** Noise frequency (zoom). */
  scale: number
  /** Domain-warp strength. */
  warp: number
  /** Cursor swirl strength. */
  swirl: number
  /** Vein sharpness exponent. */
  veins: number
  /** Film grain amount. */
  grain: number
  /** Base oklch hue in degrees. */
  hue: number
  /** 0 = modern, 1 = VCR mode. */
  vcr: number
}

export const defaultParams: HeroParams = {
  speed: 0.32,
  scale: 1.6,
  warp: 3.2,
  swirl: 2.4,
  veins: 9,
  grain: 0.05,
  hue: 150,
  vcr: 0,
}

/** Ranges for UI controls (playground). */
export const paramRanges: Record<keyof HeroParams, { min: number; max: number; step: number }> = {
  speed: { min: 0, max: 2, step: 0.01 },
  scale: { min: 0.3, max: 5, step: 0.01 },
  warp: { min: 0, max: 8, step: 0.01 },
  swirl: { min: 0, max: 8, step: 0.01 },
  veins: { min: 1, max: 40, step: 0.1 },
  grain: { min: 0, max: 0.3, step: 0.001 },
  hue: { min: 0, max: 360, step: 1 },
  vcr: { min: 0, max: 1, step: 1 },
}

export interface FrameState {
  width: number
  height: number
  /** Cursor in centered, y-up, height-normalized space. */
  mouseX: number
  mouseY: number
  velX: number
  velY: number
  time: number
  /** 0 at top of page, 1 once the hero has scrolled out. */
  scroll: number
}

/** Packs into 4 × vec4 — identical layout for the GLSL and WGSL shaders. */
export const UNIFORM_FLOATS = 16

export function packUniforms(out: Float32Array, s: FrameState, p: HeroParams): Float32Array {
  out[0] = s.width
  out[1] = s.height
  out[2] = s.mouseX
  out[3] = s.mouseY
  out[4] = s.velX
  out[5] = s.velY
  out[6] = s.time
  out[7] = s.scroll
  out[8] = p.hue
  out[9] = p.vcr
  out[10] = p.speed
  out[11] = p.scale
  out[12] = p.warp
  out[13] = p.swirl
  out[14] = p.veins
  out[15] = p.grain
  return out
}
