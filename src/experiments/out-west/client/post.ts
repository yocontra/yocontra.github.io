import {
  type AppBase,
  type CameraComponent,
  CameraFrame,
  Color,
  FILTER_LINEAR,
  type LightComponent,
  PIXELFORMAT_RGBA8,
  SSAOTYPE_LIGHTING,
  Texture,
  TONEMAP_ACES,
} from 'playcanvas'

/** The slice of a lighting preset the grade reads. */
export interface GradePreset {
  sunElev: number
  bloom: number
  saturation: number
  contrast: number
  shadowTint: readonly number[]
  highTint: readonly number[]
  rays: number
}

const LUT_SIZE = 16
/** Bloom intensity at a preset `bloom` of 1 (night); the CameraFrame range is 0-0.1. */
const BLOOM = 0.03
/** How much of the authored saturation and contrast survive ACES, which already adds both. */
const GRADE_SHARE = 0.55
/** How far the authored shadow/highlight tints split-tone the image. */
const SPLIT_TONE = 0.7

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x)
}

/**
 * The western grade in display space, after ACES: an S-curve for the authored contrast (the
 * CameraFrame grading pivots linear HDR at 0.5 and crushes night to black), saturation, and a
 * split tone with the cool authored shadow tint and the warm highlight tint.
 */
function fillLut(data: Uint8Array, preset: GradePreset): void {
  const [sr = 1, sg = 1, sb = 1] = preset.shadowTint
  const [hr = 1, hg = 1, hb = 1] = preset.highTint
  const curve = Math.max(0, (preset.contrast - 1) * GRADE_SHARE * 2)
  const saturation = 1 + (preset.saturation - 1) * GRADE_SHARE
  const grade = (value: number, luma: number, tint: number): number =>
    Math.round(Math.min(1, Math.max(0, lerp(luma, value, saturation) * tint)) * 255)
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const red = lerp(r / (LUT_SIZE - 1), smoothstep(r / (LUT_SIZE - 1)), curve)
        const green = lerp(g / (LUT_SIZE - 1), smoothstep(g / (LUT_SIZE - 1)), curve)
        const blue = lerp(b / (LUT_SIZE - 1), smoothstep(b / (LUT_SIZE - 1)), curve)
        const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
        const shadow = (1 - luma) ** 2 * SPLIT_TONE
        const high = luma ** 2 * SPLIT_TONE
        const index = (g * LUT_SIZE * LUT_SIZE + b * LUT_SIZE + r) * 4
        data[index] = grade(red, luma, lerp(1, sr, shadow) * lerp(1, hr, high))
        data[index + 1] = grade(green, luma, lerp(1, sg, shadow) * lerp(1, hg, high))
        data[index + 2] = grade(blue, luma, lerp(1, sb, shadow) * lerp(1, hb, high))
        data[index + 3] = 255
      }
    }
  }
}

/**
 * The high tier's native CameraFrame: HDR scene target with MSAA, ACES, bloom, a western grade
 * from the lighting presets, AO and sun-lit volumetric dust for light shafts. The low tier never
 * builds one and keeps the single forward pass.
 */
export class NativePost {
  private readonly frame: CameraFrame
  private readonly lut: Texture
  private readonly sun: LightComponent | null
  private frontier = false as boolean
  private dense = false as boolean
  private shafts = 0
  constructor(app: AppBase, camera: CameraComponent, sun: LightComponent | null) {
    this.sun = sun
    this.lut = new Texture(app.graphicsDevice, {
      name: 'western-grade-lut',
      width: LUT_SIZE * LUT_SIZE,
      height: LUT_SIZE,
      format: PIXELFORMAT_RGBA8,
      srgb: true,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
    })
    const frame = new CameraFrame(app, camera)
    frame.rendering.toneMapping = TONEMAP_ACES
    frame.rendering.samples = 4
    frame.bloom.blurLevel = 7
    frame.bloom.threshold = 0.9
    frame.colorLUT.texture = this.lut
    frame.colorLUT.intensity = 1
    frame.vignette.intensity = 0.32
    frame.vignette.inner = 0.55
    frame.vignette.outer = 1.25
    frame.vignette.curvature = 0.6
    frame.ssao.type = SSAOTYPE_LIGHTING
    frame.ssao.intensity = 0.45
    frame.ssao.radius = 0.9
    frame.ssao.samples = 10
    frame.ssao.power = 4
    frame.ssao.scale = 0.5
    this.frame = frame
    frame.update()
  }
  /** Re-grades for a lighting preset; `frontier` keeps the open town's wider, thinner dust. */
  grade(preset: GradePreset, frontier: boolean): void {
    this.frontier = frontier
    const frame = this.frame
    frame.bloom.intensity = BLOOM * preset.bloom
    const data = this.lut.lock() as Uint8Array
    fillLut(data, preset)
    this.lut.unlock()
    // Shafts read where a low sun rakes through dust; a high sun or the moon barely shows them.
    this.shafts = preset.sunElev > 0 ? Math.max(0.3, Math.min(0.6, preset.rays)) : 0.15
    this.applyFog()
  }
  /** Daily fog thickens the scattering volume instead of stacking a second effect. */
  dailyFog(enabled: boolean): void {
    this.dense = enabled
    this.applyFog()
  }
  private applyFog(): void {
    const fog = this.frame.volumetricFog
    fog.enabled = true
    fog.light = this.sun
    fog.tint = new Color(1, 0.9, 0.76)
    fog.density = this.frontier ? 0.006 : 0.008
    if (this.dense) {
      fog.density = 0.03
    }
    fog.heightBase = 0.5
    fog.heightFalloff = this.dense ? 0.12 : 0.22
    fog.extinction = 0.35
    fog.anisotropy = 0.6
    fog.intensity = this.shafts * (this.dense ? 0.6 : 1.1)
    fog.ambientColor = new Color(0.62, 0.58, 0.52)
    fog.ambientIntensity = this.dense ? 0.08 : 0.02
    fog.maxDistance = this.frontier ? 110 : 90
    fog.steps = 20
    fog.scale = 0.5
    this.frame.update()
  }
  destroy(): void {
    this.frame.destroy()
    this.lut.destroy()
  }
}
