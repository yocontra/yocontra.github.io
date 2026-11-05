/**
 * Quality tiers (design doc §9.4): the ladder, the device prior and the 1.5 s
 * GPU micro-benchmark. Pure data plus two small functions; render.ts applies
 * the result.
 */

import {
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PointLight,
  Scene,
  SphereGeometry,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { type FormFactor, readDevice } from '../platform/device.ts'
import { IOS_UA } from '../platform/native.ts'
import { getSettings } from '../settings.ts'

export type Quality = 'high' | 'medium' | 'floor' | 'legacy'

export const QUALITIES: readonly Quality[] = ['high', 'medium', 'floor', 'legacy']

export interface TierSpec {
  /** Upper bound on the backing-store pixel ratio. */
  dprMax: number
  /** Dynamic resolution range, as a fraction of the tier's pixel ratio. */
  scaleMin: number
  scaleMax: number
  /** 4 = 4× MSAA (free on tile-based GPUs); 0 = none, FXAA instead. */
  msaa: number
  shadowSize: number
  /** Ambient dust motes. */
  dust: number
  /** Heat shimmer in the lens pass. */
  shimmer: boolean
  /** Bloom resolution scale and mip levels. */
  bloomRes: number
  bloomLevels: number
  /** The bloom mip chain and composite. Off on the phone Frontier pass. */
  bloom: boolean
  /** Vignette and grain (only the top tiers). */
  fullPost: boolean
  /** The depth-reading height-fog pass. Off on phones, where the scene's linear fog carries it. */
  atmos: boolean
  /** The time-of-day LUT pair inside the grade pass (two 3D texture reads per pixel). */
  lut: boolean
  /** Redraw the sun's shadow map every N frames (1 = every frame). */
  shadowHz: number
}

/** Quick Draw budgets per tier; §9.3 sets the floor row. */
export const TIER_SPECS: Record<Quality, TierSpec> = {
  high: {
    dprMax: 2,
    scaleMin: 0.8,
    scaleMax: 1,
    msaa: 4,
    shadowSize: 2048,
    dust: 1500,
    shimmer: true,
    bloomRes: 0.5,
    bloomLevels: 5,
    bloom: true,
    fullPost: true,
    atmos: true,
    lut: true,
    shadowHz: 1,
  },
  medium: {
    dprMax: 1.75,
    scaleMin: 0.8,
    scaleMax: 1,
    msaa: 4,
    shadowSize: 1536,
    dust: 1000,
    shimmer: true,
    bloomRes: 0.5,
    bloomLevels: 5,
    bloom: true,
    fullPost: true,
    atmos: true,
    lut: true,
    shadowHz: 1,
  },
  floor: {
    dprMax: 1.6,
    scaleMin: 0.72,
    scaleMax: 1,
    msaa: 4,
    shadowSize: 1024,
    dust: 600,
    shimmer: false,
    bloomRes: 0.5,
    bloomLevels: 4,
    bloom: true,
    fullPost: true,
    atmos: true,
    lut: true,
    shadowHz: 2,
  },
  legacy: {
    dprMax: 1,
    scaleMin: 0.7,
    scaleMax: 1,
    msaa: 0,
    shadowSize: 1024,
    dust: 300,
    shimmer: false,
    bloomRes: 0.5,
    bloomLevels: 3,
    bloom: true,
    fullPost: false,
    atmos: true,
    lut: true,
    shadowHz: 2,
  },
}

export type RenderMode = 'duel' | 'ffa'

/**
 * Frontier FFA budgets (§9.3): lower internal resolution, wider dynamic range, and a phone pass
 * that keeps the frame cheap in the places a phone actually pays: the depth-reading height fog,
 * the LUT, the bloom mip chain and the shadow redraws. The scene's linear fog and the grade's
 * plain contrast carry the look instead.
 */
const FFA_DPR: Record<Quality, Partial<TierSpec>> = {
  high: { dprMax: 1.75, scaleMin: 0.7 },
  medium: { dprMax: 1.5, scaleMin: 0.7, bloomLevels: 4, shadowHz: 2 },
  floor: {
    dprMax: 1.3,
    scaleMin: 0.6,
    msaa: 2,
    shadowSize: 1024,
    dust: 450,
    bloomRes: 0.35,
    bloomLevels: 2,
    bloom: false,
    fullPost: false,
    atmos: false,
    lut: false,
    // 2 Hz shadows on the phone pass: the sun barely moves, and the redraw is a whole extra
    // scene pass. Riders' shadows still follow at 2 Hz, which reads fine at phone distance.
    shadowHz: 10,
  },
  legacy: {
    dprMax: 1,
    scaleMin: 0.6,
    msaa: 0,
    shadowSize: 1024,
    dust: 240,
    bloomRes: 0.35,
    bloomLevels: 2,
    bloom: false,
    fullPost: false,
    atmos: false,
    lut: false,
    shadowHz: 4,
  },
}

export function specFor(q: Quality, mode: RenderMode): TierSpec {
  return mode === 'ffa' ? { ...TIER_SPECS[q], ...FFA_DPR[q] } : TIER_SPECS[q]
}

/** Bump when the benchmark or thresholds change, so cached tiers re-measure. */
const BENCH_VERSION = 'v1'
const CACHE_KEY = `ow-quality:${BENCH_VERSION}`

export function isQuality(s: string | null | undefined): s is Quality {
  return s === 'high' || s === 'medium' || s === 'floor' || s === 'legacy'
}

/** `#tier=` / `?tier=` with a full tier name forces it (no benchmark). */
export function forcedQuality(): Quality | null {
  const hash = new URLSearchParams(location.hash.slice(1)).get('tier')
  const query = new URLSearchParams(location.search).get('tier')
  const v = hash ?? query
  if (isQuality(v)) {
    return v
  }
  // main.ts's coarse hint, when spelled out explicitly
  if (v === 'low') {
    return 'floor'
  }
  // the Settings sheet's Graphics: Low is the floor tier, High the top; Auto benchmarks
  const g = getSettings().graphics
  if (g === 'low') {
    return 'floor'
  }
  return g === 'high' ? 'high' : null
}

interface Cached {
  q: Quality
  ms: number
  ua: string
}

export function cachedQuality(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }
    const c = JSON.parse(raw) as Partial<Cached>
    if (isQuality(c.q) && c.ua === navigator.userAgent && typeof c.ms === 'number') {
      return { q: c.q, ms: c.ms, ua: c.ua }
    }
  } catch {
    // storage blocked: measure again
  }
  return null
}

function storeQuality(q: Quality, ms: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ q, ms, ua: navigator.userAgent }))
  } catch {
    // private mode: fine, measure next boot
  }
}

const SOFTWARE_GL = /swiftshader|llvmpipe|software/iu

/**
 * The device prior. On iOS the renderer string only says "Apple GPU", so the
 * prior is the form factor (`platform/device.ts`). The benchmark then confirms
 * or moves it.
 */
export function priorQuality(gl: WebGLRenderer): Quality {
  const ctx = gl.getContext()
  const ext = ctx.getExtension('WEBGL_debug_renderer_info')
  const name = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
  if (SOFTWARE_GL.test(name)) {
    return 'legacy'
  }
  const d = readDevice()
  return devicePrior({
    form: d.form,
    short: d.screenShort,
    ios: IOS_UA.test(navigator.userAgent),
    cores: navigator.hardwareConcurrency || 4,
    mem: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4,
    coarse: matchMedia('(pointer: coarse)').matches,
  })
}

/**
 * The prior per form factor:
 * - a foldable (iPhone Duo, A20 Pro) starts at medium on either panel (its 3x inner panel is
 *   capped by medium's DPR, and dynamic resolution handles the rest);
 * - an iPad is high with a short side of 1000+ px (the 13" Pro and Air, M-series), else medium;
 * - an iPhone (13 mini, A15) is the floor: Safari may report 4 cores, so iOS never goes by
 *   cores (the benchmark moves it); other phones need 6 cores and 4 GB for the floor;
 * - a desktop is high (medium with only a coarse pointer).
 */
export function devicePrior(d: {
  form: FormFactor
  short: number
  ios: boolean
  cores: number
  mem: number
  coarse: boolean
}): Quality {
  switch (d.form) {
    case 'fold-outer':
    case 'fold-inner':
      return 'medium'
    case 'tablet':
      return d.short >= 1000 ? 'high' : 'medium'
    case 'phone':
      if (d.ios) {
        return 'floor'
      }
      return d.cores >= 6 && d.mem >= 4 ? 'floor' : 'legacy'
    default:
      return d.coarse ? 'medium' : 'high'
  }
}

/**
 * main.ts's and Frontier's coarse hint to the renderer: 'low' (start at the floor, no device
 * prior) for phones only; tablets, foldables and desktops take `priorQuality`.
 */
export function tierHint(): 'low' | 'high' {
  return readDevice().form === 'phone' ? 'low' : 'high'
}

/**
 * Thresholds in ms per benchmark render (see `benchmarkGpu`). Calibrated on an
 * M2 Max (≈0.9 ms) and scaled by published GPU throughput: A15 4-core ≈ 10×
 * slower, A16 ≈ 1.25× faster than A15, A17 Pro ≈ 1.8×. Re-calibrate on real
 * devices (tools/PERF.md).
 */
const A15_MS = 9
export const THRESHOLDS = {
  high: A15_MS / 1.7,
  medium: A15_MS / 1.15,
  floor: A15_MS * 1.6,
} as const

export function classify(ms: number, prior: Quality): Quality {
  let q: Quality = 'legacy'
  if (ms <= THRESHOLDS.high) {
    q = 'high'
  } else if (ms <= THRESHOLDS.medium) {
    q = 'medium'
  } else if (ms <= THRESHOLDS.floor) {
    q = 'floor'
  }
  // A phone never benchmarks above medium unless it's clearly a Pro-class chip.
  if (prior === 'floor' && q === 'high' && ms > THRESHOLDS.high * 0.8) {
    q = 'medium'
  }
  return q
}

/**
 * 1.5 s micro-benchmark: the heaviest lit standard material (shadowed sun,
 * two point lights, 40k triangles, full-screen coverage) rendered into a
 * 1024×512 offscreen target and timed with gl.finish(). Runs in short slices
 * across animation frames so the title screen stays responsive.
 */
export function benchmarkGpu(gl: WebGLRenderer, budgetMs = 1500): Promise<number> {
  const scene = new Scene()
  const mat = new MeshStandardMaterial({ color: 0x88_66_44, roughness: 0.6, metalness: 0.2 })
  const geo = new SphereGeometry(0.5, 128, 80)
  for (let x = -2; x <= 2; x++) {
    for (let y = -1; y <= 1; y++) {
      const m = new Mesh(geo, mat)
      m.position.set(x * 0.9, y * 0.9, 0)
      m.castShadow = true
      m.receiveShadow = true
      scene.add(m)
    }
  }
  const sun = new DirectionalLight(0xff_ff_ff, 2)
  sun.position.set(1, 2, 3)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  scene.add(sun, new PointLight(0xff_aa_66, 4, 10), new PointLight(0x66_aa_ff, 4, 10))
  const cam = new OrthographicCamera(-2.4, 2.4, 1.2, -1.2, 0.1, 20)
  cam.position.set(0, 0, 5)
  const rt = new WebGLRenderTarget(1024, 512, { samples: 4 })
  const ctx = gl.getContext()
  const prevTarget = gl.getRenderTarget()
  const prevShadow = gl.shadowMap.enabled
  const run = (n: number): number => {
    gl.shadowMap.enabled = true
    gl.setRenderTarget(rt)
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      gl.render(scene, cam)
    }
    ctx.finish()
    const dt = performance.now() - t0
    gl.setRenderTarget(prevTarget)
    gl.shadowMap.enabled = prevShadow
    return dt
  }
  return new Promise((resolve) => {
    // warm-up (shader compile) is not timed
    run(1)
    let spent = 0
    let renders = 0
    const samples: number[] = []
    const slice = () => {
      const n = 4
      const dt = run(n)
      spent += dt
      renders += n
      samples.push(dt / n)
      if (spent < budgetMs && renders < 400) {
        requestAnimationFrame(slice)
        return
      }
      samples.sort((a, b) => a - b)
      // median slice: robust to a GC pause or a compositor hiccup
      const ms = samples[Math.floor(samples.length / 2)] ?? spent / renders
      geo.dispose()
      mat.dispose()
      rt.dispose()
      sun.shadow.map?.dispose()
      resolve(ms)
    }
    requestAnimationFrame(slice)
  })
}

/** Benchmark, classify against the prior, and cache for this browser build. */
export async function detectQuality(
  gl: WebGLRenderer,
  prior: Quality,
): Promise<{ q: Quality; ms: number }> {
  const ms = await benchmarkGpu(gl)
  const q = classify(ms, prior)
  storeQuality(q, ms)
  return { q, ms }
}
