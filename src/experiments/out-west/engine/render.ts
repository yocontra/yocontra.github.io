// biome-ignore-all lint/style/noExcessiveClassesPerFile: small, related effect classes kept together
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import {
  Color,
  DirectionalLight,
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
import { GpuTimer, PerfOverlay, perfRequested, Window } from '../ui/perf.ts'
import { LUT_SIZE, lutsAt } from './lut.ts'
import { TownProbe } from './probe.ts'
import {
  cachedQuality,
  detectQuality,
  forcedQuality,
  priorQuality,
  type Quality,
  type RenderMode,
  specFor,
  type TierSpec,
} from './tiers.ts'

/**
 * The coarse hint main.ts passes ('high' on desktop, 'low' on touch). The
 * real ladder is `Quality` (tiers.ts); the hint only seeds the device prior.
 */
export type Tier = 'high' | 'low'

export type { Quality, RenderMode, TierSpec } from './tiers.ts'

const gradeFrag = /* glsl */ `
uniform float saturation;
uniform float contrast;
uniform vec3 shadowTint;
uniform vec3 highTint;
uniform float lift;
uniform float flash;
uniform vec3 flashColor;
uniform float exposure;
uniform lowp sampler3D lutA;
uniform lowp sampler3D lutB;
uniform float lutMix;
uniform float lutAmount;
uniform float lutScale;
uniform float lutOffset;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * exposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(shadowTint, highTint, smoothstep(0.02, 0.6, l));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c = max(c, 0.0);
  c = pow(c / 0.18, vec3(contrast)) * 0.18;
  c = c + lift * (1.0 - c);
  if (lutAmount > 0.0) {
    vec3 s = clamp(toSrgb(clamp(c, 0.0, 1.0)), 0.0, 1.0) * lutScale + lutOffset;
    vec3 g = mix(texture(lutA, s).rgb, texture(lutB, s).rgb, lutMix);
    c = mix(c, toLinear(g), lutAmount);
  }
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

/** Live parametric grade plus the time-of-day LUT look, in one effect. */
export class GradeEffect extends Effect {
  constructor() {
    const first = lutsAt(0)
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
        ['lutA', new Uniform(first.a)],
        ['lutB', new Uniform(first.b)],
        ['lutMix', new Uniform(0)],
        ['lutAmount', new Uniform(1)],
        ['lutScale', new Uniform((LUT_SIZE - 1) / LUT_SIZE)],
        ['lutOffset', new Uniform(0.5 / LUT_SIZE)],
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
  /** Pick the two LUTs bracketing the time of day. */
  setDay(day: number): void {
    const l = lutsAt(day)
    this.u('lutA').value = l.a
    this.u('lutB').value = l.b
    this.u('lutMix').value = l.t
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

/** Dynamic resolution (§9.4): step size, cadence, and the thermal rule. */
const DYN = {
  step: 0.05,
  everyMs: 500,
  /** Scale pinned at its floor this long means thermal throttling: drop a tier. */
  thermalMs: 180_000,
  /** After a step down, wait this long before trying to climb. */
  holdMs: 4000,
} as const

const NEXT_DOWN: Record<Quality, Quality | null> = {
  high: 'medium',
  medium: 'floor',
  floor: 'legacy',
  legacy: null,
}

export class Renderer {
  readonly gl: WebGLRenderer
  readonly composer: EffectComposer
  readonly bloom: BloomEffect
  readonly vignette: VignetteEffect
  readonly noise: NoiseEffect
  readonly grade = new GradeEffect()
  readonly lens = new LensEffect()
  readonly probe: TownProbe
  private readonly lensPass: EffectPass
  private readonly mainPass: EffectPass
  private fxaaPass: EffectPass | null = null
  private readonly renderPass: RenderPass
  /** The active quality tier. */
  tier: Quality
  spec: TierSpec
  /** Backing-store pixel ratio now in use (tier ratio × dynamic scale). */
  dpr: number
  /** Dynamic resolution scale within the tier's range. */
  scale = 1
  benchMs: number | null = null
  thermalDrops = 0
  lowPower = false
  readonly intervals = new Window(240)
  readonly cpu = new Window(240)
  readonly gpu: GpuTimer | null
  readonly frame = { calls: 0, triangles: 0 }
  private readonly perf: PerfOverlay | null
  private readonly black = new MeshBasicMaterial({ color: 0x00_00_00 })
  readonly scene: Scene
  private readonly camera: PerspectiveCamera
  private lastFrame = 0
  private lastAdapt = 0
  private holdUntil = 0
  private floorSince = 0
  private lastDay = -1
  private readonly mode: RenderMode

  get quality(): string {
    return this.tier
  }

  // biome-ignore lint/complexity/useMaxParams: game.ts calls the 4-argument form; mode is an optional trailing flag for the FFA scene
  constructor(
    canvas: HTMLCanvasElement,
    scene: Scene,
    camera: PerspectiveCamera,
    hint: Tier,
    mode: RenderMode = 'duel',
  ) {
    this.mode = mode
    this.scene = scene
    this.camera = camera
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
    // The post passes would each reset the counters: count the whole frame.
    this.gl.info.autoReset = false

    const forced = forcedQuality()
    const cached = cachedQuality()
    const prior = hint === 'low' ? 'floor' : priorQuality(this.gl)
    this.tier = forced ?? cached?.q ?? prior
    this.benchMs = cached?.ms ?? null
    this.spec = specFor(this.tier, mode)
    this.dpr = this.baseDpr()

    this.composer = new EffectComposer(this.gl, {
      frameBufferType: HalfFloatType,
      multisampling: this.maxSamples(this.spec.msaa),
    })
    this.renderPass = new RenderPass(scene, camera)
    this.composer.addPass(this.renderPass)
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.2,
      intensity: 0.6,
      resolutionScale: this.spec.bloomRes,
      levels: this.spec.bloomLevels,
    })
    this.vignette = new VignetteEffect({ darkness: 0.35, offset: 0.3 })
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false })
    this.noise.blendMode.opacity.value = 0.05
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
    // Lens (CA / shimmer / blur) runs first on the HDR frame and is off unless
    // a moment asks for it. Everything else is ONE merged pass (§9.3): the
    // half-res bloom composite, AgX, grade + LUT, vignette and grain.
    this.lensPass = new EffectPass(camera, this.lens)
    this.lensPass.enabled = false
    this.composer.addPass(this.lensPass)
    this.mainPass = new EffectPass(camera, this.bloom, tone, this.grade, this.vignette, this.noise)
    this.composer.addPass(this.mainPass)
    this.applyPostForTier()

    this.probe = new TownProbe(this.gl, scene)
    this.gpu = perfRequested() ? new GpuTimer(this.gl.getContext() as WebGL2RenderingContext) : null
    this.perf = perfRequested() ? new PerfOverlay(this) : null
    if (this.perf) {
      Reflect.set(globalThis, '__owPerf', () => this.perf?.snapshot())
      Reflect.set(globalThis, '__owRenderer', this)
    }
    this.resize()

    if (!(forced || cached)) {
      detectQuality(this.gl, prior)
        .then(({ q, ms }) => {
          this.benchMs = ms
          this.setTier(q)
        })
        .catch(() => undefined)
    }
  }

  private maxSamples(n: number): number {
    return n > 0 ? Math.min(n, this.gl.capabilities.maxSamples) : 0
  }

  private baseDpr(): number {
    return Math.min(window.devicePixelRatio || 1, this.spec.dprMax)
  }

  /** Legacy: no MSAA, an FXAA pass instead, and only tonemap + LUT. */
  private applyPostForTier(): void {
    const s = this.spec
    this.composer.multisampling = this.maxSamples(s.msaa)
    this.bloom.resolution.scale = s.bloomRes
    this.vignette.blendMode.opacity.value = s.fullPost ? 1 : 0
    this.noise.blendMode.opacity.value = s.fullPost ? this.noise.blendMode.opacity.value : 0
    if (s.msaa === 0 && !this.fxaaPass) {
      this.fxaaPass = new EffectPass(this.camera, new FXAAEffect())
      this.composer.addPass(this.fxaaPass)
    } else if (s.msaa > 0 && this.fxaaPass) {
      this.composer.removePass(this.fxaaPass)
      this.fxaaPass.dispose()
      this.fxaaPass = null
    }
  }

  /** Switch tiers at runtime (benchmark result or a thermal drop). */
  setTier(q: Quality): void {
    if (q === this.tier) {
      return
    }
    this.tier = q
    this.spec = specFor(q, this.mode)
    this.scale = 1
    this.dpr = this.baseDpr()
    this.applyPostForTier()
    // shadow maps re-allocate at the new size on the next render
    const size = this.spec.shadowSize
    this.scene.traverse((o) => {
      if (o instanceof DirectionalLight && o.castShadow && o.shadow.mapSize.x !== size) {
        o.shadow.mapSize.set(size, size)
        o.shadow.map?.dispose()
        o.shadow.map = null
      }
    })
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

  /**
   * Dynamic resolution, driven by rAF timing (there is no GPU timer on iOS).
   * Every 0.5 s: if the p90 frame interval misses the display's refresh by
   * more than 15 %, step the scale down by 0.05; if frames are on time and the
   * CPU has headroom, step up. Pinned at the floor for 3 minutes means
   * thermal throttling: drop one tier, never climbing back this session.
   * Called by the game loop only outside tense moments, so the resolution
   * never shifts during a draw. Returns true when the tier dropped.
   */
  adapt(_frameMs: number, allowTierDrop: boolean): boolean {
    const now = performance.now()
    if (now - this.lastAdapt < DYN.everyMs || this.intervals.count < 30) {
      return false
    }
    this.lastAdapt = now
    const refresh = this.intervals.pct(0.1)
    const p90 = this.intervals.pct(0.9)
    const med = this.intervals.pct(0.5)
    // iOS Low Power Mode caps rAF at 30 Hz: steady ~33 ms frames with idle CPU.
    const capped = med > 30 && med < 37 && refresh > 28 && this.cpu.pct(0.9) < 10
    this.lowPower = capped
    if (capped) {
      return false
    }
    const s = this.spec
    let next = this.scale
    if (p90 > Math.max(refresh * 1.15, 17.5)) {
      next = Math.max(s.scaleMin, this.scale - DYN.step)
      this.holdUntil = now + DYN.holdMs
    } else if (p90 < refresh * 1.06 && now > this.holdUntil && this.cpu.pct(0.9) < refresh * 0.6) {
      next = Math.min(s.scaleMax, this.scale + DYN.step)
    }
    if (next !== this.scale) {
      this.scale = next
      this.dpr = this.baseDpr() * next
      this.resize()
    }
    if (this.scale <= s.scaleMin + 1e-6) {
      this.floorSince ||= now
    } else {
      this.floorSince = 0
    }
    const down = NEXT_DOWN[this.tier]
    if (allowTierDrop && down && this.floorSince && now - this.floorSince > DYN.thermalMs) {
      this.floorSince = 0
      this.thermalDrops++
      this.setTier(down)
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
    // rAF timestamp of this frame (document.timeline tracks it during callbacks)
    const frameStart = Number(document.timeline.currentTime ?? performance.now())
    if (this.lastFrame > 0 && frameStart > this.lastFrame) {
      this.intervals.push(frameStart - this.lastFrame)
    }
    this.lastFrame = frameStart
    this.gl.info.reset()
    const day = this.scene.userData.owDay as number | undefined
    if (day !== undefined && day !== this.lastDay) {
      this.lastDay = day
      this.grade.setDay(day)
    }
    this.gpu?.begin()
    this.probe.tick()
    this.composer.render(dt)
    this.gpu?.end()
    const info = this.gl.info.render
    this.frame.calls = info.calls
    this.frame.triangles = info.triangles
    this.cpu.push(performance.now() - frameStart)
    this.perf?.update(frameStart)
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
