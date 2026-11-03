// biome-ignore-all lint/style/noExcessiveClassesPerFile: small, related effect classes kept together
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import {
  Color,
  HalfFloatType,
  type Material,
  MeshBasicMaterial,
  NoToneMapping,
  type PerspectiveCamera,
  type Scene,
  SRGBColorSpace,
  Uniform,
  Vector3,
  WebGLRenderer,
} from 'three'

export type Tier = 'high' | 'low'

export interface TierSpec {
  dprMax: number
  shadowSize: number
  smaa: boolean
  dust: number
  shimmer: boolean
  bloomRes: number
}

export const TIERS: Record<Tier, TierSpec> = {
  high: { dprMax: 1.5, shadowSize: 2048, smaa: true, dust: 1500, shimmer: true, bloomRes: 1 },
  low: { dprMax: 1.25, shadowSize: 1024, smaa: false, dust: 500, shimmer: false, bloomRes: 0.5 },
}

const gradeFrag = /* glsl */ `
uniform float saturation;
uniform float contrast;
uniform vec3 shadowTint;
uniform vec3 highTint;
uniform float lift;
uniform float flash;
uniform vec3 flashColor;
uniform float exposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * exposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(shadowTint, highTint, smoothstep(0.02, 0.6, l));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c = max(c, 0.0);
  c = pow(c / 0.18, vec3(contrast)) * 0.18;
  c = c + lift * (1.0 - c);
  c = mix(c, flashColor, flash);
  outputColor = vec4(c, inputColor.a);
}
`

const lensFrag = /* glsl */ `
uniform float ca;
uniform float shimmer;
uniform float blur;
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec2 p = uv;
  if (shimmer > 0.0) {
    float z = -getViewZ(depth);
    float far = smoothstep(30.0, 80.0, z) * step(depth, 0.99999);
    float band = smoothstep(0.3, 0.45, uv.y) * (1.0 - smoothstep(0.55, 0.7, uv.y));
    float n = sin(uv.y * 180.0 + time * 6.0) * 0.6 + sin(uv.y * 97.0 - time * 4.3) * 0.4;
    p.x += n * 0.0012 * shimmer * far * band;
  }
  vec2 dir = (uv - 0.5);
  vec3 col;
  if (ca > 0.0001) {
    col.r = texture2D(inputBuffer, p + dir * ca).r;
    col.g = texture2D(inputBuffer, p).g;
    col.b = texture2D(inputBuffer, p - dir * ca).b;
  } else {
    col = texture2D(inputBuffer, p).rgb;
  }
  if (blur > 0.0) {
    vec2 o = texelSize * 2.5 * blur;
    vec3 s = texture2D(inputBuffer, p + vec2(o.x, o.y)).rgb + texture2D(inputBuffer, p + vec2(-o.x, o.y)).rgb
      + texture2D(inputBuffer, p + vec2(o.x, -o.y)).rgb + texture2D(inputBuffer, p + vec2(-o.x, -o.y)).rgb;
    col = mix(col, s * 0.25, clamp(blur, 0.0, 1.0));
  }
  outputColor = vec4(col, inputColor.a);
}
`

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', gradeFrag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['saturation', new Uniform(1)],
        ['contrast', new Uniform(1.05)],
        ['shadowTint', new Uniform(new Vector3(1, 1, 1))],
        ['highTint', new Uniform(new Vector3(1, 1, 1))],
        ['lift', new Uniform(0)],
        ['flash', new Uniform(0)],
        ['flashColor', new Uniform(new Vector3(1, 1, 1))],
        ['exposure', new Uniform(1)],
      ]),
    })
  }
  u(name: string): Uniform {
    const u = this.uniforms.get(name)
    if (!u) {
      throw new Error(name)
    }
    return u
  }
}

export class LensEffect extends Effect {
  constructor() {
    super('LensEffect', lensFrag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['ca', new Uniform(0)],
        ['shimmer', new Uniform(0)],
        ['blur', new Uniform(0)],
      ]),
    })
  }
  u(name: string): Uniform {
    const u = this.uniforms.get(name)
    if (!u) {
      throw new Error(name)
    }
    return u
  }
}

export class Renderer {
  readonly gl: WebGLRenderer
  readonly composer: EffectComposer
  readonly bloom: BloomEffect
  readonly vignette: VignetteEffect
  readonly noise: NoiseEffect
  readonly grade = new GradeEffect()
  readonly lens = new LensEffect()
  private readonly lensPass: EffectPass
  private readonly mainPass: EffectPass
  private readonly smaaPass: EffectPass | null
  private readonly renderPass: RenderPass
  tier: Tier
  spec: TierSpec
  dpr: number
  private readonly frameTimes: number[] = []
  private tierDropped = false
  private readonly black = new MeshBasicMaterial({ color: 0x00_00_00 })
  private readonly scene: Scene
  private readonly camera: PerspectiveCamera

  constructor(canvas: HTMLCanvasElement, scene: Scene, camera: PerspectiveCamera, tier: Tier) {
    this.scene = scene
    this.camera = camera
    this.tier = tier
    this.spec = TIERS[tier]
    this.gl = new WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    })
    this.gl.outputColorSpace = SRGBColorSpace
    this.gl.toneMapping = NoToneMapping
    this.gl.shadowMap.enabled = true
    this.dpr = Math.min(window.devicePixelRatio || 1, this.spec.dprMax)
    this.gl.setPixelRatio(this.dpr)

    this.composer = new EffectComposer(this.gl, { frameBufferType: HalfFloatType })
    this.renderPass = new RenderPass(scene, camera)
    this.composer.addPass(this.renderPass)
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.2,
      intensity: 0.6,
      resolutionScale: this.spec.bloomRes,
    })
    this.vignette = new VignetteEffect({ darkness: 0.35, offset: 0.3 })
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false })
    this.noise.blendMode.opacity.value = 0.05
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    // Lens (CA / shimmer / blur) runs first on the HDR frame and can be toggled
    // off freely: the always-on grade pass (or SMAA) is what reaches the screen.
    this.lensPass = new EffectPass(camera, this.lens)
    this.composer.addPass(this.lensPass)
    this.mainPass = new EffectPass(camera, this.bloom, tone, this.grade, this.vignette, this.noise)
    this.composer.addPass(this.mainPass)
    if (this.spec.smaa) {
      this.smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }))
      this.composer.addPass(this.smaaPass)
    } else {
      this.smaaPass = null
    }
    this.resize()
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.gl.setPixelRatio(this.dpr)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Feed frame time; adapts DPR and (once) drops a tier when unlocked. Returns true if tier dropped. */
  adapt(frameMs: number, allowTierDrop: boolean): boolean {
    const ft = this.frameTimes
    ft.push(frameMs)
    if (ft.length < 120) {
      return false
    }
    const avg = ft.reduce((a, b) => a + b, 0) / ft.length
    ft.length = 0
    const max = Math.min(window.devicePixelRatio || 1, this.spec.dprMax)
    let next = this.dpr
    if (avg > 19) {
      next = Math.max(0.75, this.dpr - 0.15)
    } else if (avg < 14 && this.dpr < max) {
      next = Math.min(max, this.dpr + 0.1)
    }
    if (next !== this.dpr) {
      this.dpr = next
      this.resize()
    }
    if (avg > 20 && this.dpr <= 0.9 && allowTierDrop && !this.tierDropped && this.tier === 'high') {
      this.tierDropped = true
      this.tier = 'low'
      this.spec = TIERS.low
      if (this.smaaPass) {
        this.composer.removePass(this.smaaPass)
        this.mainPass.renderToScreen = true
      }
      this.bloom.resolution.scale = 0.5
      return true
    }
    return false
  }

  setLens(ca: number, shimmer: number, blur: number): void {
    this.lens.u('ca').value = ca
    this.lens.u('shimmer').value = this.spec.shimmer ? shimmer : 0
    this.lens.u('blur').value = blur
    this.lensPass.enabled = ca > 0.0001 || (this.spec.shimmer && shimmer > 0) || blur > 0
  }

  render(dt: number): void {
    this.composer.render(dt)
  }

  /** The red flash frame: black silhouettes on pure #F00, bypassing all grading. */
  renderSilhouette(hidden: { visible: boolean }[]): void {
    const scene = this.scene
    const prevBg = scene.background
    const prevFog = scene.fog
    const prevOverride: Material | null = scene.overrideMaterial
    const states = hidden.map((o) => o.visible)
    for (const o of hidden) {
      o.visible = false
    }
    scene.background = new Color(0xff_00_00)
    scene.fog = null
    scene.overrideMaterial = this.black
    const prevShadow = this.gl.shadowMap.autoUpdate
    this.gl.shadowMap.autoUpdate = false
    this.gl.setRenderTarget(null)
    this.gl.render(scene, this.camera)
    this.gl.shadowMap.autoUpdate = prevShadow
    scene.overrideMaterial = prevOverride
    scene.background = prevBg
    scene.fog = prevFog
    hidden.forEach((o, i) => {
      o.visible = states[i] ?? true
    })
  }
}
