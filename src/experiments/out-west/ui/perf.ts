// biome-ignore-all lint/style/noExcessiveClassesPerFile: the overlay and its two small samplers (window, GPU timer) belong together
/**
 * Performance overlay (design doc §9.6), shown with `?debug=perf` or `#perf`.
 * It's kept in production behind the flag. Self-contained: the renderer feeds
 * it once per frame, and it reads `renderer.info` plus whatever the browser
 * exposes (JS heap on Chromium, GPU timer queries where the extension exists;
 * neither is available on iOS).
 */
import type { Object3D, Scene, Texture, WebGLRenderer } from 'three'

export function perfRequested(): boolean {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.slice(1))
  return q.get('debug') === 'perf' || h.has('perf') || h.get('debug') === 'perf'
}

/** Rolling window of samples with percentile reads. */
export class Window {
  private readonly buf: Float32Array
  private n = 0
  private i = 0
  private readonly sorted: Float32Array

  constructor(size: number) {
    this.buf = new Float32Array(size)
    this.sorted = new Float32Array(size)
  }

  push(v: number): void {
    this.buf[this.i] = v
    this.i = (this.i + 1) % this.buf.length
    this.n = Math.min(this.n + 1, this.buf.length)
  }

  get count(): number {
    return this.n
  }

  clear(): void {
    this.n = 0
    this.i = 0
  }

  /** p in 0..1 over the filled part of the window. */
  pct(p: number): number {
    if (this.n === 0) {
      return 0
    }
    const s = this.sorted.subarray(0, this.n)
    s.set(this.buf.subarray(0, this.n))
    s.sort()
    return s[Math.min(this.n - 1, Math.floor(p * this.n))] ?? 0
  }

  mean(): number {
    let t = 0
    for (const v of this.buf.subarray(0, this.n)) {
      t += v
    }
    const n = this.count
    return n > 0 ? t / n : 0
  }
}

interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

/** GPU frame time via EXT_disjoint_timer_query_webgl2 (desktop Chromium; never iOS). */
export class GpuTimer {
  private readonly gl: WebGL2RenderingContext
  private readonly ext: TimerExt | null
  private readonly pending: WebGLQuery[] = []
  private active: WebGLQuery | null = null
  readonly samples = new Window(120)

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null
  }

  get available(): boolean {
    return this.ext !== null
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) {
      return
    }
    const q = this.gl.createQuery()
    if (!q) {
      return
    }
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.active = q
  }

  end(): void {
    if (!(this.ext && this.active)) {
      return
    }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push(this.active)
    this.active = null
    this.poll()
  }

  private poll(): void {
    const gl = this.gl
    const ext = this.ext
    if (!ext) {
      return
    }
    const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT))
    while (this.pending.length > 0) {
      const q = this.pending[0] as WebGLQuery
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        break
      }
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number
      if (!disjoint) {
        this.samples.push(ns / 1e6)
      }
      gl.deleteQuery(q)
      this.pending.shift()
    }
  }
}

export interface PerfSource {
  readonly gl: WebGLRenderer
  readonly scene: Scene
  readonly quality: string
  readonly dpr: number
  readonly scale: number
  readonly benchMs: number | null
  readonly thermalDrops: number
  readonly lowPower: boolean
  readonly intervals: Window
  readonly cpu: Window
  readonly gpu: GpuTimer | null
  readonly frame: { calls: number; triangles: number }
}

/** Rough GPU bytes for one texture (mips add a third). */
function texBytes(t: Texture): number {
  const img = t.image as { width?: number; height?: number; depth?: number } | null
  const w = img?.width ?? 0
  const h = img?.height ?? 0
  const d = img?.depth ?? 1
  const bpp = (t as Texture & { isCompressedTexture?: boolean }).isCompressedTexture ? 1 : 4
  return w * h * d * bpp * (t.generateMipmaps ? 4 / 3 : 1)
}

/** Estimated MB of textures referenced by the scene's materials (plus env and background). */
export function estimateTextureMb(scene: Scene): number {
  const seen = new Set<Texture>()
  const visit = (o: Object3D) => {
    const m = (o as Object3D & { material?: unknown }).material
    const mats: unknown[] = Array.isArray(m) ? m : [m]
    for (const mat of mats) {
      if (!mat) {
        continue
      }
      for (const v of Object.values(mat as Record<string, unknown>)) {
        if (v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture) {
          seen.add(v as Texture)
        }
      }
    }
  }
  scene.traverse(visit)
  for (const t of [scene.environment, scene.background]) {
    if (t && (t as Texture).isTexture) {
      seen.add(t as Texture)
    }
  }
  let b = 0
  for (const t of seen) {
    b += texBytes(t)
  }
  return b / 1_048_576
}

export class PerfOverlay {
  private readonly el: HTMLPreElement
  private readonly src: PerfSource
  private last = 0
  private texMb = 0
  private texAt = 0

  constructor(src: PerfSource) {
    this.src = src
    const el = document.createElement('pre')
    el.className = 'ow-perf'
    el.setAttribute('aria-hidden', 'true')
    Object.assign(el.style, {
      position: 'fixed',
      right: 'max(8px, env(safe-area-inset-right))',
      top: 'max(56px, env(safe-area-inset-top))',
      zIndex: '9999',
      margin: '0',
      padding: '6px 8px',
      font: '11px/1.35 ui-monospace, Menlo, monospace',
      color: '#b8f7c0',
      background: 'rgba(0,0,0,0.62)',
      borderRadius: '4px',
      pointerEvents: 'none',
      whiteSpace: 'pre',
    } satisfies Partial<CSSStyleDeclaration>)
    document.body.appendChild(el)
    this.el = el
  }

  update(now: number): void {
    if (now - this.last < 250) {
      return
    }
    this.last = now
    const s = this.src
    if (now - this.texAt > 2000) {
      this.texAt = now
      this.texMb = estimateTextureMb(s.scene)
    }
    const info = s.gl.info
    const iv = s.intervals
    const p50 = iv.pct(0.5)
    const fps = p50 > 0 ? 1000 / iv.mean() : 0
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    const gpu = s.gpu?.available
      ? `${s.gpu.samples.pct(0.5).toFixed(2)}/${s.gpu.samples.pct(0.95).toFixed(2)} ms`
      : 'n/a'
    const lines = [
      `fps ${fps.toFixed(0)}  frame p50 ${p50.toFixed(1)} p95 ${iv.pct(0.95).toFixed(1)} ms`,
      `cpu p50 ${s.cpu.pct(0.5).toFixed(2)} p95 ${s.cpu.pct(0.95).toFixed(2)} ms  gpu ${gpu}`,
      `draws ${s.frame.calls}  tris ${(s.frame.triangles / 1000).toFixed(1)}k`,
      `tex ${info.memory.textures} (~${this.texMb.toFixed(1)} MB)  geo ${info.memory.geometries}  prog ${info.programs?.length ?? 0}`,
      `heap ${mem ? `${(mem.usedJSHeapSize / 1_048_576).toFixed(1)} MB` : 'n/a'}`,
      `tier ${s.quality}  dpr ${s.dpr.toFixed(2)} (scale ${s.scale.toFixed(2)})`,
      `bench ${s.benchMs === null ? '-' : `${s.benchMs.toFixed(2)} ms`}  thermal drops ${s.thermalDrops}${s.lowPower ? '  LOW POWER 30 Hz' : ''}`,
    ]
    this.el.textContent = lines.join('\n')
  }

  /** Snapshot for scripted measurement (tools/perf-run.ts reads it). */
  snapshot(): Record<string, number | string | boolean | null> {
    const s = this.src
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    return {
      fps: s.intervals.mean() > 0 ? 1000 / s.intervals.mean() : 0,
      frameP50: s.intervals.pct(0.5),
      frameP95: s.intervals.pct(0.95),
      cpuP50: s.cpu.pct(0.5),
      cpuP95: s.cpu.pct(0.95),
      gpuP50: s.gpu?.available ? s.gpu.samples.pct(0.5) : null,
      gpuP95: s.gpu?.available ? s.gpu.samples.pct(0.95) : null,
      draws: s.frame.calls,
      tris: s.frame.triangles,
      textures: s.gl.info.memory.textures,
      textureMb: estimateTextureMb(s.scene),
      geometries: s.gl.info.memory.geometries,
      programs: s.gl.info.programs?.length ?? 0,
      heapMb: mem ? mem.usedJSHeapSize / 1_048_576 : null,
      tier: s.quality,
      dpr: s.dpr,
      scale: s.scale,
      benchMs: s.benchMs,
      thermalDrops: s.thermalDrops,
      lowPower: s.lowPower,
    }
  }
}
