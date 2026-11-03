/**
 * Debug-only audio meter, enabled with `#audiodebug` in the URL hash.
 *
 * Taps the master output (after the limiter) and each bus with an
 * AnalyserNode, samples them every animation frame, and keeps a timeline of
 * engine calls so a spike can be lined up with whatever caused it. Everything
 * lives on `globalThis.__owAudio` for the console (or Playwright) to read.
 */

export interface MeterFrame {
  /** AudioContext time of the sample. */
  t: number
  tap: string
  /** Peak |sample| over the analyser window, dBFS. */
  peak: number
  /** RMS over the analyser window, dBFS. */
  rms: number
  /** Mean energy of the 4–12 kHz FFT bins, dB. */
  hf: number
  /** True when the window held a NaN or Infinity sample. */
  bad: boolean
}

export interface AudioEvent {
  t: number
  name: string
  args: string
}

interface Tap {
  name: string
  node: AnalyserNode
  time: Float32Array<ArrayBuffer>
  freq: Float32Array<ArrayBuffer>
}

const MAX_FRAMES = 40_000
const MAX_EVENTS = 4000
const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -200)

/**
 * `null` when off; otherwise the flag's value (`#audiodebug` gives '',
 * `#audiodebug=raw` gives 'raw', which turns the re-trigger guard off for A/B).
 */
export function audioDebugMode(): string | null {
  if (typeof location === 'undefined') {
    return null
  }
  return new URLSearchParams(location.hash.slice(1)).get('audiodebug')
}

export class AudioDebug {
  readonly frames: MeterFrame[] = []
  readonly events: AudioEvent[] = []
  /** `#audiodebug=raw`: skip the re-trigger guard, to measure the unguarded mix. */
  readonly raw: boolean
  private readonly taps: Tap[] = []
  private readonly warned = new Set<string>()
  private readonly ctx: AudioContext
  private readonly statsOf: () => Record<string, number>

  constructor(ctx: AudioContext, mode: string, stats: () => Record<string, number> = () => ({})) {
    this.ctx = ctx
    this.statsOf = stats
    this.raw = mode === 'raw'
    const tick = () => {
      this.sample()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    Reflect.set(globalThis, '__owAudio', this)
  }

  /** Meter `src` (fan-out only; the analyser feeds nothing). */
  tap(name: string, src: AudioNode): void {
    const node = this.ctx.createAnalyser()
    // 2048 samples ≈ 43 ms at 48 kHz: longer than a frame, so no gaps.
    node.fftSize = 2048
    node.smoothingTimeConstant = 0
    src.connect(node)
    this.taps.push({
      name,
      node,
      time: new Float32Array(node.fftSize),
      freq: new Float32Array(node.frequencyBinCount),
    })
  }

  log(name: string, ...args: unknown[]): void {
    this.events.push({ t: this.ctx.currentTime, name, args: args.map((a) => fmt(a)).join(', ') })
    if (this.events.length > MAX_EVENTS) {
      this.events.shift()
    }
  }

  /** Warn once per label about a non-finite or out-of-range param value. */
  warn(label: string, value: unknown): void {
    this.log('BAD', label, value)
    if (this.warned.has(label)) {
      return
    }
    this.warned.add(label)
    console.warn(`[audio] bad value for ${label}:`, value)
  }

  private sample(): void {
    const t = this.ctx.currentTime
    const binHz = this.ctx.sampleRate / 2048
    const lo = Math.floor(4000 / binHz)
    const hi = Math.ceil(12_000 / binHz)
    for (const tap of this.taps) {
      tap.node.getFloatTimeDomainData(tap.time)
      let peak = 0
      let sum = 0
      let bad = false
      for (const s of tap.time) {
        if (!Number.isFinite(s)) {
          bad = true
          continue
        }
        const a = Math.abs(s)
        peak = Math.max(peak, a)
        sum += s * s
      }
      tap.node.getFloatFrequencyData(tap.freq)
      let e = 0
      for (let i = lo; i <= hi; i++) {
        e += 10 ** ((tap.freq[i] ?? -200) / 10)
      }
      this.frames.push({
        t,
        tap: tap.name,
        peak: toDb(peak),
        rms: toDb(Math.sqrt(sum / tap.time.length)),
        hf: 10 * Math.log10(e / (hi - lo + 1) + 1e-30),
        bad,
      })
    }
    if (this.frames.length > MAX_FRAMES) {
      this.frames.splice(0, this.frames.length - MAX_FRAMES)
    }
  }

  /** Engine memory and voice counts (decoded MB, live voices, streams, media decks). */
  stats(): Record<string, number> {
    return this.statsOf()
  }

  clear(): void {
    this.frames.length = 0
    this.events.length = 0
  }
}

function fmt(a: unknown): string {
  if (typeof a === 'number') {
    return Number.isFinite(a) ? String(Math.round(a * 1000) / 1000) : String(a)
  }
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a)
    } catch {
      return '[obj]'
    }
  }
  return String(a)
}
