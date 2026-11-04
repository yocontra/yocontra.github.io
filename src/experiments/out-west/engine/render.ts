// biome-ignore-all lint/style/noExcessiveClassesPerFile: small, related effect classes kept together
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the renderer, its effects and the boot warm-up are one cohesive module
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
  Matrix4,
  MeshBasicMaterial,
  NoToneMapping,
  type PerspectiveCamera,
  type Scene,
  SRGBColorSpace,
  Uniform,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { ATMOS, HAZE_GLSL } from '../scene/atmos.ts'
import { GpuTimer, PerfOverlay, perfRequested, Window } from '../ui/perf.ts'
import { LUT_SIZE, lutsAt } from './lut.ts'
import { applyOverlay, type OverlaySpec } from './overlay.ts'
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
import { compileOverride } from './warm.ts'

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

/** Chromatic aberration fades out between these times of day (0 noon, 0.5 sunset, 1 midnight). */
const NIGHT_CA_FROM = 0.6
const NIGHT_CA_TO = 0.75

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

const atmosFrag = /* glsl */ `
uniform mat4 atmCamWorld;
uniform mat4 atmProjInv;
uniform float atmDensity;
uniform float atmFalloff;
uniform float atmRays;
uniform vec2 atmSunUv;
uniform vec3 atmSunDir;
${HAZE_GLSL}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  vec4 vp = atmProjInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vp.xyz /= vp.w;
  vec3 cam = atmCamWorld[3].xyz;
  vec3 rd = (atmCamWorld * vec4(vp.xyz, 1.0)).xyz - cam;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  vec3 sd = normalize(atmSunDir);
  if (depth < 0.99999 && atmDensity > 0.0) {
    // exponential height fog, integrated along the view ray, coloured like the sky behind it
    float a = atmDensity * exp(-atmFalloff * max(cam.y, 0.0));
    float b = rd.y * atmFalloff;
    float integ = abs(b) > 1e-4 ? (1.0 - exp(-b * dist)) / b : dist;
    float fog = 1.0 - exp(-a * integ);
    col = mix(col, atmHaze(rd, sd), clamp(fog, 0.0, 0.96));
  }
  if (atmRays > 0.0) {
    // screen-space sun shafts: march toward the sun, counting open sky
    vec2 stepUv = (atmSunUv - uv) / 22.0;
    vec2 q = uv;
    float w = 1.0;
    float acc = 0.0;
    for (int i = 0; i < 22; i++) {
      q += stepUv;
      if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
        break;
      }
      acc += step(0.99999, readDepth(q)) * w;
      w *= 0.93;
    }
    float facing = pow(max(dot(rd, sd), 0.0), 5.0);
    col += atmSunColor * (acc / 13.0) * atmRays * facing;
  }
  outputColor = vec4(col, inputColor.a);
}
`

/**
 * Aerial perspective (exponential height fog in the sky's own haze colour, so the town fades into
 * the horizon behind it) and, on the high tier, screen-space sun shafts. Reads the depth buffer.
 */
export class AtmosEffect extends Effect {
  private readonly camWorld = new Uniform(new Matrix4())
  private readonly projInv = new Uniform(new Matrix4())
  readonly density = new Uniform(0)
  readonly falloff = new Uniform(0.03)
  readonly rays = new Uniform(0)
  private readonly sunUv = new Uniform(new Vector2(0.5, 0.5))
  private readonly tmp = new Vector3()
  constructor() {
    super('AtmosEffect', atmosFrag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>(),
    })
    const u = this.uniforms
    u.set('atmCamWorld', this.camWorld)
    u.set('atmProjInv', this.projInv)
    u.set('atmDensity', this.density)
    u.set('atmFalloff', this.falloff)
    u.set('atmRays', this.rays)
    u.set('atmSunUv', this.sunUv)
    u.set('atmSunDir', ATMOS.atmSunDir)
    u.set('atmSunColor', ATMOS.atmSunColor)
    u.set('atmHorizon', ATMOS.atmHorizon)
    u.set('atmZenith', ATMOS.atmZenith)
    u.set('atmGlow', ATMOS.atmGlow)
  }

  /** Per frame: the camera's matrices, and where the sun sits on screen (shafts fade off it). */
  track(cam: PerspectiveCamera, rays: number): void {
    cam.updateMatrixWorld()
    this.camWorld.value.copy(cam.matrixWorld)
    this.projInv.value.copy(cam.projectionMatrixInverse)
    const p = this.tmp.copy(ATMOS.atmSunDir.value).multiplyScalar(1000).add(cam.position)
    p.project(cam)
    this.sunUv.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5)
    // only while the sun is in front of the camera and not far off screen
    const on = p.z < 1 && Math.abs(p.x) < 1.6 && Math.abs(p.y) < 1.6 ? 1 : 0
    this.rays.value = rays * on
  }
}

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
  step: 0.06,
  /** A badly missed frame budget drops this much at once. */
  bigStep: 0.12,
  everyMs: 300,
  /** Scale pinned at its floor this long means thermal throttling: drop a tier. */
  thermalMs: 180_000,
  /** After a step down, wait this long before trying to climb. */
  holdMs: 4000,
  /** Low Power Mode's 30 Hz cap held this long: step down one tier (once a session). */
  lowPowerMs: 3000,
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
  readonly atmos = new AtmosEffect()
  readonly probe: TownProbe
  private readonly lensPass: EffectPass
  private mainPass: EffectPass
  private readonly tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
  private fxaaPass: EffectPass | null = null
  private readonly renderPass: RenderPass
  /** A scene drawn over the main one, before the post chain (Frontier's first-person gun). */
  private overlayPass: RenderPass | null = null
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
  /** What is on screen (a duel phase, `frontier`…), for the perf snapshot's per-phase stats. */
  label = ''
  /** The WebGL context is gone (iOS memory pressure) until the browser restores it. */
  readonly context: { lost: boolean } = { lost: false }
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
  /** The size and ratio last applied by `resize()`. */
  private readonly applied = { w: 0, h: 0, dpr: 0 }

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
    // three.js fetches every program's and shader's info log after linking when this is on. On
    // ANGLE (Chrome) and WebKit that call blocks until the driver has finished compiling, so the
    // programs link one at a time: tens of seconds of the boot on a phone. Keep it for development
    // (where a broken shader must say so) and never pay for it in a shipped build.
    this.gl.debug.checkShaderErrors = import.meta.env.DEV
    // The post passes would each reset the counters: count the whole frame.
    this.gl.info.autoReset = false
    // iOS drops the WebGL context under memory pressure (often while backgrounded). three.js
    // keeps the canvas restorable; meanwhile nothing draws. Static geometry frees its CPU copies
    // after upload (scene/release.ts), so a restored context can't be refilled in place: reload.
    canvas.addEventListener('webglcontextlost', () => {
      this.context.lost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      location.reload()
    })

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
    // Lens (CA / shimmer / blur) runs first on the HDR frame and is off unless
    // a moment asks for it. Everything else is ONE merged pass (§9.3): the
    // half-res bloom composite, AgX, grade + LUT, vignette and grain. The phone
    // tiers also leave the height fog and the LUT out of that pass entirely.
    this.lensPass = new EffectPass(camera, this.lens)
    this.lensPass.enabled = false
    this.composer.addPass(this.lensPass)
    this.mainPass = this.makeMainPass()
    this.composer.addPass(this.mainPass)
    this.applyPostForTier()

    // The town light probe captures the whole scene into a cube and pre-filters it. That capture
    // compiles a *linear* variant of every standard-material program (roughly doubles the program
    // count) and renders the street six more times, which is the wrong trade on a phone. The phone
    // tiers get a cheap gradient environment in the same colours instead (probe.ts), so the look
    // holds and the boot does not.
    this.probe = new TownProbe(this.gl, scene, this.tier === 'high' || this.tier === 'medium')
    this.gpu = perfRequested() ? new GpuTimer(this.gl.getContext() as WebGL2RenderingContext) : null
    this.perf = perfRequested() ? new PerfOverlay(this) : null
    if (this.perf) {
      Reflect.set(globalThis, '__owPerf', () => this.perf?.snapshot())
      // cheap enough to read every frame (the snapshot walks the scene for texture memory)
      Reflect.set(globalThis, '__owPerfLabel', () => this.label)
      if (import.meta.env.DEV || import.meta.env.PUBLIC_OW_PERF_HARNESS === '1') {
        // the live renderer reaches the whole scene graph: dev and perf-harness builds only
        Reflect.set(globalThis, '__owRenderer', this)
      }
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

  /**
   * One merged pass for the whole grade. The phone tiers leave the height-fog pass, the LUT and
   * the full-screen grain out of the shader instead of running them at zero strength: a merged
   * effect still costs its ALU and texture reads on a phone.
   */
  private makeMainPass(): EffectPass {
    const s = this.spec
    const effects: Effect[] = [this.tone, this.grade]
    if (s.bloom) {
      effects.unshift(this.bloom)
    }
    if (s.atmos) {
      effects.unshift(this.atmos)
    }
    if (s.fullPost) {
      effects.push(this.vignette, this.noise)
    }
    return new EffectPass(this.camera, ...effects)
  }

  /** Rebuild the merged pass to match the tier (called at boot and on a tier change). */
  private rebuildMainPass(): void {
    const next = this.makeMainPass()
    const at = this.composer.passes.indexOf(this.mainPass)
    if (at >= 0) {
      this.composer.removePass(this.mainPass)
      this.mainPass.dispose()
      this.composer.addPass(next, at)
    } else {
      // after the lens pass, before the FXAA pass when there is one
      this.composer.addPass(next, 2)
    }
    this.mainPass = next
  }

  /** Legacy: no MSAA, an FXAA pass instead, and only tonemap + LUT. */
  private applyPostForTier(): void {
    const s = this.spec
    this.composer.multisampling = this.maxSamples(s.msaa)
    this.bloom.resolution.scale = s.bloomRes
    // postprocessing exposes `levels` at runtime; its typings only carry the getter on the pass
    ;(this.bloom as BloomEffect & { levels: number }).levels = s.bloomLevels
    this.grade.u('lutAmount').value = s.lut ? 1 : 0
    this.vignette.blendMode.opacity.value = s.fullPost ? 1 : 0
    this.noise.blendMode.opacity.value = s.fullPost ? this.noise.blendMode.opacity.value : 0
    this.rebuildMainPass()
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

  /**
   * Fits the backing store to the viewport. Skips the work when nothing changed: iOS fires
   * `resize` for toolbar and keyboard moves, and Stage Manager fires dozens while a window is
   * dragged, and every real resize reallocates the composer's targets (a visible hitch). The
   * pixel ratio is re-read each time, since an iPad window can move to an external display.
   */
  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.dpr = this.baseDpr() * this.scale
    const a = this.applied
    if (w === a.w && h === a.h && this.dpr === a.dpr) {
      return
    }
    a.w = w
    a.h = h
    a.dpr = this.dpr
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
    const rawRefresh = this.intervals.pct(0.1)
    // A game that is stuck at 30 fps reports ~33 ms for its fastest frames too. Without the cap
    // the estimator would mistake that for a 30 Hz display and never lower the resolution. 60 Hz
    // is the lowest target the game aims for, so never infer a slower display than that.
    const refresh = Math.min(rawRefresh, 1000 / 60)
    const p90 = this.intervals.pct(0.9)
    const med = this.intervals.pct(0.5)
    // iOS Low Power Mode caps rAF at 30 Hz: steady ~33 ms frames with idle CPU.
    const capped = med > 30 && med < 37 && rawRefresh > 28 && this.cpu.pct(0.9) < 10
    this.lowPower = capped
    if (capped) {
      return this.lowPowerStep(now, allowTierDrop)
    }
    this.lowPowerSince = 0
    const s = this.spec
    let next = this.scale
    const late = p90 > Math.max(refresh * 1.15, 17.5)
    if (late) {
      // a frame that misses by a lot gets a bigger step: recover 60 fps in a few hundred ms
      const step = p90 > Math.max(refresh * 1.5, 24) ? DYN.bigStep : DYN.step
      next = Math.max(s.scaleMin, this.scale - step)
      this.holdUntil = now + DYN.holdMs
    } else if (p90 < refresh * 1.06 && now > this.holdUntil && this.cpu.pct(0.9) < refresh * 0.55) {
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

  /**
   * Low Power Mode (iOS caps rAF at 30 Hz to save battery): the frame has twice the time, but the
   * player asked for less power, so after 3 s of it step down one tier, once a session, and keep
   * the resolution where it is (a drop in resolution wouldn't lift the cap).
   */
  private lowPowerStep(now: number, allowTierDrop: boolean): boolean {
    this.lowPowerSince ||= now
    const down = NEXT_DOWN[this.tier]
    if (
      !allowTierDrop ||
      this.lowPowerDropped ||
      !down ||
      now - this.lowPowerSince < DYN.lowPowerMs
    ) {
      return false
    }
    this.lowPowerDropped = true
    this.setTier(down)
    return true
  }

  private lowPowerSince = 0
  private shadowFrame = 0
  private lensWarm = 0

  /**
   * The sun's shadow map is redrawn every `spec.shadowHz` frames (1 = every frame, 2 = 30 Hz,
   * 3 = 20 Hz, 4 = 15 Hz). The map and its matrix stay a matched pair, so a skipped frame shows
   * the last frame's moving shadows (a rider, a duelist's arm), never a misplaced one. The shadow
   * pass walks the whole scene and redraws every caster, so on phones it is one of the first
   * things to slow down.
   */
  private shadowRate(): void {
    const sm = this.gl.shadowMap
    const hz = Math.max(1, this.spec.shadowHz)
    this.shadowFrame++
    sm.autoUpdate = hz === 1
    if (hz > 1) {
      sm.needsUpdate = this.shadowFrame % hz === 0
    }
  }
  private lowPowerDropped = false

  /** The Frontier view model's overlay pass (`engine/overlay.ts`); null removes it. */
  setOverlay(o: OverlaySpec | null): void {
    this.overlayPass = applyOverlay(this.composer, this.overlayPass, o)
  }

  /**
   * The lens pass. `night` (0 noon … 1 midnight) fades the chromatic aberration out after dusk:
   * on a dark frame the split catches every star and dust mote as a red and a blue speck.
   */
  setLens(caIn: number, shimmer: number, blur: number, night = 0): void {
    const t = Math.min(1, Math.max(0, (night - NIGHT_CA_FROM) / (NIGHT_CA_TO - NIGHT_CA_FROM)))
    const ca = caIn * (1 - t * t * (3 - 2 * t))
    this.lens.u('ca').value = ca
    this.lens.u('shimmer').value = this.spec.shimmer ? shimmer : 0
    this.lens.u('blur').value = blur
    this.lensPass.enabled = ca > 0.0001 || (this.spec.shimmer && shimmer > 0) || blur > 0
  }

  render(dt: number): void {
    if (this.context.lost) {
      return
    }
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
    const ud = this.scene.userData
    this.atmos.density.value = (ud.owHaze as number | undefined) ?? 0
    // sun shafts are a high-tier luxury
    const rays = this.tier === 'high' ? ((ud.owRays as number | undefined) ?? 0) : 0
    this.atmos.track(this.camera, rays)
    this.gpu?.begin()
    this.shadowRate()
    this.probe.tick()
    // the lens pass's program compiles on its first use: draw the first frames with it on (at
    // zero strength it changes nothing), so that's at load, not on the frame of the first kill
    const lensOn = this.lensPass.enabled
    const warm = this.lensWarm < 2
    if (warm) {
      this.lensPass.enabled = true
    }
    this.composer.render(dt)
    if (warm) {
      this.lensWarm++
      this.lensPass.enabled = lensOn
    }
    this.gpu?.end()
    const info = this.gl.info.render
    this.frame.calls = info.calls
    this.frame.triangles = info.triangles
    this.cpu.push(performance.now() - frameStart)
    this.perf?.update(frameStart)
  }

  /**
   * Compile and draw once, synchronously. Use when a loading screen is already up and total time
   * matters more than keeping the page responsive (Frontier's own boot). The duel uses `warm`,
   * which spreads the same reflection across frames behind the title.
   */
  warmSync(scene: Scene, camera: PerspectiveCamera): void {
    try {
      this.gl.compile(scene, camera)
      this.gl.render(scene, camera)
    } catch {
      // the first real frame will report it
    }
  }

  /**
   * Compile the scene's programs, then reflect their uniforms in small slices.
   *
   * `WebGLRenderer.compile` builds the programs, but three does not query their uniforms until the
   * first draw that uses them. That reflection (`WebGLUniforms`) is one blocking driver call per
   * active uniform, and a standard material has a hundred of them: on a phone it is tens of
   * seconds, and doing it on the first frame freezes the title. One program per animation frame
   * keeps the page responsive and lets the loading copy move. Call `warmSilhouette` afterwards.
   */
  async warm(
    scene: Scene,
    camera: PerspectiveCamera,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    try {
      this.gl.compile(scene, camera)
    } catch {
      // Older drivers: the draw below compiles whatever is missing.
    }
    const programs = new Set<{ getUniforms: () => unknown }>()
    scene.traverse((o) => {
      const d = o as { material?: Material | Material[] }
      const material = d.material
      if (!material) {
        return
      }
      for (const m of Array.isArray(material) ? material : [material]) {
        const props = this.gl.properties.get(m) as
          | { currentProgram?: { getUniforms: () => unknown } }
          | undefined
        const program = props?.currentProgram
        if (program) {
          programs.add(program)
        }
      }
    })
    const list = [...programs]
    if (list.length === 0) {
      onProgress?.(1)
      return
    }
    let i = 0
    await new Promise<void>((resolve) => {
      const step = () => {
        // One program per slice: a shared program is reflected once, and a single call can still
        // be a few hundred ms on a slow driver.
        list[i]?.getUniforms()
        i++
        onProgress?.(i / list.length)
        if (i < list.length) {
          requestAnimationFrame(step)
        } else {
          resolve()
        }
      }
      requestAnimationFrame(step)
    })
    // A real draw now creates the shadow-depth programs and fills the draw state. The uniforms are
    // already reflected, so this is the cheap part.
    try {
      this.gl.render(scene, camera)
    } catch {
      // the first real frame will report it
    }
  }

  /**
   * Compile the red flash frame's programs now (call it at a level's setup), not on the frame of
   * the winning shot: the black override needs its own variant per kind of object (skinned,
   * instanced, morphed), and a new outlaw can bring a new one. Same state as the flash frame
   * (no fog, drawn to the screen), every drawable in the scene, not only what's in view.
   */
  warmSilhouette(hidden: readonly { visible: boolean }[]): void {
    compileOverride({ gl: this.gl, scene: this.scene, camera: this.camera }, this.black, hidden)
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
