// biome-ignore-all lint/complexity/useMaxParams: audio builders take positional numeric args (x, y, z, fallback, range…), mirroring the Web Audio and three.js APIs
// biome-ignore-all lint/style/useThisInClassMethods: graph-building helpers live on the engine they build for
// biome-ignore-all lint/suspicious/noShadow: local name mirrors the field it configures
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the engine is one cohesive mixer (graph, voices, loops, music, the call); data lives in catalog.ts and streaming in stream.ts
/**
 * Web Audio mix (design doc §4.5, §10.5). One AudioContext for everything:
 *
 *   one-shots ─┬─ sfx bus ─┐
 *              ├─ reverb + slap-back ─┤
 *   beds (streamed) ─ amb bus ─┼─ master ─ glue comp ─ limiter ─ soft clip ─ out
 *   songs (streamed) ─ lowpass ─ level ─ music bus ─┘
 *   stings (streamed) ──────────────── music bus
 *
 * One-shots are decoded up front per pack (`core` at boot, `frontier` on demand) so nothing
 * decodes mid-duel. Beds and music stream from media elements and are never decoded (`stream.ts`).
 * Voices come from a capped pool, and every start and stop runs a short gain ramp so nothing
 * clicks. The call (`call()`) is the one sound the game hinges on: never positional, never
 * quieter, and everything else steps aside for it.
 */

import {
  BUFFER_LOOPS,
  type FileName,
  type Layer,
  LOOPS,
  type LoopName,
  layersOf,
  MUSIC_TRIM,
  type Pack,
  PRIORITY,
  SFX_FILES,
  type SfxName,
  SONGS,
  type SongName,
  STINGS,
  type StingName,
  type UiName,
} from './catalog.ts'
import { AudioDebug, audioDebugMode } from './debug.ts'
import { DeckPool } from './deck-pool.ts'
import { Stream } from './stream.ts'

export type { LoopName, Pack, SfxName, SongName, StingName, UiName } from './catalog.ts'
export type Bus = 'sfx' | 'amb' | 'music'

/** Resting bus levels. */
const BUS_LEVELS: Readonly<Record<Bus, number>> = { sfx: 0.72, amb: 0.5, music: 1.15 }
/** How far each bus ducks under the call (linear gain multiplier). */
const CALL_DUCK: readonly (readonly [Bus, number])[] = [
  ['music', 0.18],
  ['amb', 0.25],
]
/** Seconds the duck holds before music and ambience swell back. */
const CALL_DUCK_HOLD = 0.7
/** No heartbeat may sound this close after the call's strike (it would blur the bell's attack). */
const CALL_CLEAR = 0.35
/** Media elements blessed in the unlock gesture (2 per looping stream, 1 per sting). */
const DECKS = 14

export interface PlayOpts {
  gain?: number
  rate?: number
  /** World position for spatial panning. */
  pos?: { x: number; y: number; z: number }
  /** Stereo pan when no position is given (-1..1). */
  pan?: number
  /** AudioContext time to start; defaults to now. */
  when?: number
  offset?: number
  duration?: number
  bus?: Bus
  reverb?: number
  lowpass?: number
  /** Voices with priority survive pool pressure (bell, shots). */
  priority?: boolean
}

export interface Voice {
  stop: (at?: number) => void
  readonly gain: GainNode
}

export interface Loop {
  set: (value: number, ramp?: number) => void
  stop: () => void
}

interface Starts {
  /** Scheduled start times of recent accepted voices. */
  times: number[]
  /** Newest accepted voice, handed back to callers whose request was dropped. */
  voice: Voice
  /** Settings of the newest request, and when it was for. */
  sig: string
  last: number
}

interface Active {
  name: SfxName
  src: AudioBufferSourceNode
  gain: GainNode
  peak: number
  end: number
  priority: boolean
  done: boolean
}

const db = (d: number) => 10 ** (d / 20)
const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Click-free parameter change: hold whatever value the param has right now
 * (mid-ramp included) and glide exponentially toward the target. Never reads
 * `.value` (which can lag the audio thread) and never jumps.
 */
function glide(p: AudioParam, target: number, now: number, seconds: number): void {
  if (!(Number.isFinite(target) && Number.isFinite(now) && Number.isFinite(seconds))) {
    return
  }
  const hold = (p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam })
    .cancelAndHoldAtTime
  if (hold) {
    hold.call(p, now)
  } else {
    p.cancelScheduledValues(now)
    p.setValueAtTime(p.value, now)
  }
  p.setTargetAtTime(target, now, Math.max(0.01, seconds / 4))
}
/** Max simultaneous one-shot voices. */
const MAX_VOICES = 24
/**
 * Re-trigger guard. The same sample with the same settings asked for again
 * within this long of the previous request is one sound requested every
 * frame. Copies stacked a frame apart comb-filter into a loud metallic screech,
 * so the repeat is dropped and the original handle is returned. The window
 * slides with each request, so a per-frame caller gets exactly one voice.
 */
const RETRIGGER = 0.15
/** Whatever the settings, at most this many starts of one sample inside BURST seconds. */
const BURST_COUNT = 4
const BURST = 0.25
/** And at most this many live non-priority voices of one sample; the oldest is faded out. */
const MAX_PER_NAME = 4
const RATE_MIN = 0.25
const RATE_MAX = 4
const GAIN_MAX = 4
/** Fade time on every start/stop, seconds. */
const FADE = 0.006
/** Grid of the footstep files (see `tools/audio/recipes.ts`). */
const STEP = { dirt: ['dirtsteps', 6, 0.6, 0.5], wood: ['woodsteps', 6, 0.6, 0.5] } as const
const SPURS = { count: 8, step: 1, len: 0.7 } as const
const IMPACT = { body: 'hitBody', wood: 'hitWood', dirt: 'hitDirt', metal: 'ricochet' } as const

export class AudioEngine {
  ctx: AudioContext | null = null
  private master!: GainNode
  private buses!: Record<Bus, GainNode>
  private musicFilter!: BiquadFilterNode
  private musicGain!: GainNode
  private reverbIn!: GainNode
  private slapIn!: GainNode
  private pool: DeckPool | null = null
  private readonly raw = new Map<string, Promise<ArrayBuffer | null>>()
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>()
  private readonly voices: Active[] = []
  private readonly streams = new Set<Stream>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private song: { name: SongName; stream: Stream } | null = null
  private wantSong: SongName | null = null
  private readonly songOffset = new Map<SongName, number>()
  private sting: Stream | null = null
  private beds: Partial<Record<'wind' | 'windDusk' | 'windNight' | 'crickets', Loop>> = {}
  private heartBpm = 0
  private heartNext = 0
  private readonly heartVoices: { t: number; v: Voice }[] = []
  private lastCall = Number.NEGATIVE_INFINITY
  private noise: AudioBuffer | null = null
  private paused = false
  private dbg: AudioDebug | null = null
  private readonly listener = { x: 0, y: 0, z: 0 }
  private readonly packs = new Set<Pack>()
  /** Recent scheduled start times and the newest handle, per sample. */
  private readonly starts = new Map<SfxName, Starts>()

  /**
   * Every number that reaches an AudioParam goes through here: NaN/Infinity
   * fall back to a safe value and out-of-range values clamp. Debug warns once.
   */
  private num(label: string, v: number | undefined, fallback: number, lo: number, hi: number) {
    if (v === undefined) {
      return fallback
    }
    if (!Number.isFinite(v)) {
      this.dbg?.warn(label, v)
      return fallback
    }
    if (v < lo || v > hi) {
      this.dbg?.warn(label, v)
      return Math.min(hi, Math.max(lo, v))
    }
    return v
  }

  private urls(pack: Pack): string[] {
    return Object.values(SFX_FILES)
      .filter((s) => s.pack === pack)
      .map((s) => s.url)
  }

  /** Start fetching the core sounds before the first gesture. Music streams; nothing to fetch. */
  prefetch(): void {
    for (const url of this.urls('core')) {
      this.fetchRaw(url)
    }
  }

  /**
   * Fetch and decode a mode's sounds (Frontier's guns, dynamite, bank…). Resolves when decoded.
   * Safe to call before the unlock gesture (it fetches, and decodes on unlock) and repeatedly.
   */
  loadPack(pack: Pack): Promise<void> {
    this.packs.add(pack)
    const urls = this.urls(pack)
    if (!this.ctx) {
      for (const url of urls) {
        this.fetchRaw(url)
      }
      return Promise.resolve()
    }
    return Promise.all(urls.map((u) => this.decode(u))).then(() => undefined)
  }

  private fetchRaw(url: string): Promise<ArrayBuffer | null> {
    const have = this.raw.get(url)
    if (have) {
      return have
    }
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
    this.raw.set(url, p)
    return p
  }

  private decode(url: string): Promise<AudioBuffer | null> {
    const have = this.decoding.get(url)
    if (have) {
      return have
    }
    const ctx = this.ctx
    if (!ctx) {
      return Promise.resolve(null)
    }
    const p = this.fetchRaw(url).then(async (data) => {
      // The compressed bytes are only needed until decoded.
      this.raw.delete(url)
      if (!data) {
        return null
      }
      try {
        const b = await ctx.decodeAudioData(data)
        this.buffers.set(url, b)
        return b
      } catch {
        return null
      }
    })
    this.decoding.set(url, p)
    return p
  }

  get ready(): boolean {
    return this.ctx !== null
  }

  /** Must be called from inside a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state !== 'running') {
        void this.ctx.resume()
      }
      this.pool?.bless(DECKS)
      return
    }
    const Ctor = globalThis.AudioContext
    if (!Ctor) {
      return
    }
    const ctx = new Ctor({ latencyHint: 'interactive' })
    this.ctx = ctx
    void ctx.resume()
    const mode = audioDebugMode()
    this.dbg = mode === null ? null : new AudioDebug(ctx, mode, () => this.stats())
    this.dbg?.log('unlock', ctx.sampleRate)
    if (this.dbg) {
      // Debug only: lets a test drive songs and loops directly (`#audiodebug`).
      Reflect.set(globalThis, '__owAudioEngine', this)
    }
    this.buildGraph(ctx)
    this.noise = this.makeNoise(ctx, 1)
    this.pool = new DeckPool(ctx)
    this.pool.bless(DECKS)
    this.watchPage()
    this.packs.add('core')
    for (const pack of this.packs) {
      void this.loadPack(pack)
    }
  }

  private buildGraph(ctx: AudioContext): void {
    // Headroom: master at -3 dB into a gentle glue compressor, then a brickwall limiter.
    const glue = ctx.createDynamicsCompressor()
    glue.threshold.value = -16
    glue.knee.value = 10
    glue.ratio.value = 3
    glue.attack.value = 0.005
    glue.release.value = 0.2
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -2
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.08
    const trim = ctx.createGain()
    trim.gain.value = db(-2)
    this.master = ctx.createGain()
    this.master.gain.value = db(-3)
    // Backstop only: a transparent soft clipper after the limiter, so nothing
    // that slips past it can ever reach the DAC as a hard-clipped square.
    const clip = ctx.createWaveShaper()
    clip.curve = softClipCurve()
    clip.oversample = '2x'
    this.master.connect(glue).connect(trim).connect(limiter).connect(clip).connect(ctx.destination)

    const mk = (v: number) => {
      const g = ctx.createGain()
      g.gain.value = v
      g.connect(this.master)
      return g
    }
    this.buses = { sfx: mk(BUS_LEVELS.sfx), amb: mk(BUS_LEVELS.amb), music: mk(BUS_LEVELS.music) }

    this.musicFilter = ctx.createBiquadFilter()
    this.musicFilter.type = 'lowpass'
    this.musicFilter.frequency.value = 18_000
    this.musicFilter.Q.value = 0.5
    this.musicGain = ctx.createGain()
    this.musicFilter.connect(this.musicGain).connect(this.buses.music)

    const reverb = ctx.createConvolver()
    reverb.buffer = this.makeImpulse(ctx, 1.4)
    this.reverbIn = ctx.createGain()
    this.reverbIn.gain.value = 0.3
    this.reverbIn.connect(reverb).connect(this.buses.sfx)
    const slap = ctx.createDelay(0.5)
    slap.delayTime.value = 0.14
    const slapFilter = ctx.createBiquadFilter()
    slapFilter.type = 'bandpass'
    slapFilter.frequency.value = 1400
    slapFilter.Q.value = 0.6
    const slapGain = ctx.createGain()
    slapGain.gain.value = 0.25
    this.slapIn = ctx.createGain()
    this.slapIn.connect(slap).connect(slapFilter).connect(slapGain).connect(this.buses.sfx)

    if (this.dbg) {
      this.dbg.tap('out', clip)
      this.dbg.tap('music', this.buses.music)
      this.dbg.tap('sfx', this.buses.sfx)
      this.dbg.tap('amb', this.buses.amb)
    }
  }

  /** Pause streams while hidden; re-bless and retry blocked streams on any later gesture (iOS). */
  private watchPage(): void {
    if (typeof document === 'undefined') {
      return
    }
    document.addEventListener('visibilitychange', () => {
      for (const s of this.streams) {
        if (document.hidden) {
          s.pause()
        } else {
          s.resume()
        }
      }
    })
    const retry = () => {
      if (this.ctx?.state !== 'running') {
        return
      }
      this.pool?.bless(DECKS)
      for (const s of this.streams) {
        s.retry()
      }
    }
    for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) {
      globalThis.addEventListener(ev, retry, { capture: true, passive: true })
    }
  }

  /** Resolves once every core sound has decoded or failed. */
  async whenDecoded(timeoutMs = 6000): Promise<void> {
    const all = Promise.all([...this.decoding.values()])
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /** Warm the HTTP cache for a song a little ahead (it streams; nothing is decoded). */
  preloadSong(name: SongName): void {
    void fetch(SONGS[name].url)
      .then((r) => r.blob())
      .catch(() => null)
  }

  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c)
      let lp = 0
      for (let i = 0; i < len; i++) {
        const t = i / len
        lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4
        d[i] = lp * (1 - t) ** 3.2 * (i < 400 ? i / 400 : 1)
      }
    }
    return buf
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) {
      d[i] = Math.random() * 2 - 1
    }
    return buf
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0
  }

  /** Map a performance.now() timestamp to the AudioContext clock (output-latency aware). */
  perfToCtx(perfMs: number): number {
    const ctx = this.ctx
    if (!ctx) {
      return 0
    }
    const ts = ctx.getOutputTimestamp?.()
    if (ts && ts.contextTime !== undefined && ts.performanceTime && ts.contextTime > 0) {
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000
    }
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0)
    return ctx.currentTime + (perfMs - performance.now()) / 1000 - lat
  }

  /** Listener follows the camera (AudioParams only; no deprecated setters). */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void {
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    const l = ctx.listener
    if (!l.positionX) {
      return
    }
    const len = Math.hypot(fx, fy, fz)
    if (!([px, py, pz].every(Number.isFinite) && Number.isFinite(len)) || len < 1e-6) {
      this.dbg?.warn('listener', [px, py, pz, fx, fy, fz])
      return
    }
    this.listener.x = px
    this.listener.y = py
    this.listener.z = pz
    // Short smoothing so camera cuts don't step the panners (zipper noise).
    const t = ctx.currentTime
    const k = 0.015
    l.positionX.setTargetAtTime(px, t, k)
    l.positionY.setTargetAtTime(py, t, k)
    l.positionZ.setTargetAtTime(pz, t, k)
    l.forwardX.setTargetAtTime(fx / len, t, k)
    l.forwardY.setTargetAtTime(fy / len, t, k)
    l.forwardZ.setTargetAtTime(fz / len, t, k)
    if (l.upY.value !== 1) {
      l.upX.value = 0
      l.upY.value = 1
      l.upZ.value = 0
    }
  }

  has(name: SfxName): boolean {
    return layersOf(name).every((l) => this.buffers.has(SFX_FILES[l.of].url))
  }

  duration(name: SfxName): number {
    const first = layersOf(name)[0]
    return first ? (this.buffers.get(SFX_FILES[first.of].url)?.duration ?? 0) : 0
  }

  /** Free a pool slot: fade out the oldest non-priority voice. */
  private reclaim(now: number, name: SfxName | null): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i]
      if (v && (v.done || v.end < now)) {
        this.voices.splice(i, 1)
      }
    }
    // Long priority tails (a tolling bell) may overlap freely; others are capped per sample.
    const same = name === null || this.dbg?.raw ? [] : this.voices.filter((v) => v.name === name)
    for (let i = 0; i <= same.length - MAX_PER_NAME; i++) {
      const v = same[i]
      if (v) {
        this.voices.splice(this.voices.indexOf(v), 1)
        this.fadeStop(v.gain, v.src, now)
      }
    }
    while (this.voices.length >= MAX_VOICES) {
      const idx = this.voices.findIndex((v) => !v.priority)
      const v = this.voices.splice(Math.max(idx, 0), 1)[0]
      if (v) {
        this.fadeStop(v.gain, v.src, now)
      }
    }
  }

  private fadeStop(g: GainNode, src: AudioBufferSourceNode, at: number): void {
    try {
      glide(g.gain, 0, at, 0.04)
      src.stop(at + 0.08)
    } catch {
      // already stopped
    }
  }

  /**
   * Play a sound. Layered sounds (`fire`, `rifleFire`…) fire every layer; for a positioned shot
   * the diffuse town tail plays unpanned and falls off slowly while the direct crack is panned,
   * distance-attenuated and dulled by air, as a gunshot is outdoors.
   */
  play(name: SfxName, o: PlayOpts = {}): Voice | null {
    this.dbg?.log('play', name, o)
    const layers = layersOf(name)
    const priority = o.priority ?? PRIORITY.has(name)
    let first: Voice | null = null
    for (const l of layers) {
      const v = this.playLayer(l, o, priority)
      first ??= v
    }
    return first
  }

  private playLayer(l: Layer, o: PlayOpts, priority: boolean): Voice | null {
    const trim = db(l.trim ?? 0)
    const rate = (o.rate ?? 1) * (l.rate ?? 1)
    const when = l.delay ? (o.when ?? this.now) + l.delay : o.when
    const { pos, ...rest } = o
    const diffuse = Boolean(pos && l.diffuse)
    const lo: PlayOpts = { ...rest, rate, priority, gain: (o.gain ?? 1) * trim }
    if (when !== undefined) {
      lo.when = when
    }
    if (pos && !diffuse) {
      lo.pos = pos
    }
    const d = pos ? this.distance(pos) : 0
    if (diffuse) {
      // The town answers from everywhere: no panning, and a far slower falloff than the crack.
      lo.gain = (lo.gain ?? 1) * Math.min(1, 14 / (d + 10))
      lo.lowpass = Math.min(o.lowpass ?? 18_000, 9000 * Math.min(1, 30 / Math.max(30, d)))
    } else if (pos && d > 25) {
      // Air absorption: the far crack loses its top end.
      lo.lowpass = Math.min(o.lowpass ?? 18_000, Math.max(1800, 18_000 * (25 / d) ** 1.4))
    }
    return this.playFile(l.of, lo)
  }

  private distance(p: { x: number; y: number; z: number }): number {
    const d = Math.hypot(p.x - this.listener.x, p.y - this.listener.y, p.z - this.listener.z)
    return Number.isFinite(d) ? d : 0
  }

  private playFile(name: FileName, o: PlayOpts): Voice | null {
    const ctx = this.ctx
    const def = SFX_FILES[name]
    const buf = this.buffers.get(def.url)
    if (!(ctx && buf) || this.paused) {
      if (ctx && !buf) {
        // A pack that was never asked for: start loading so the next request plays.
        void this.loadPack(def.pack)
      }
      return null
    }
    const now = ctx.currentTime
    const when = Math.max(this.num('when', o.when, now, Number.NEGATIVE_INFINITY, now + 30), now)
    const sig = [o.gain, o.rate, o.offset, o.duration, o.bus, o.lowpass, o.pan, o.reverb].join('|')
    const dup = this.retrigger(name, sig, when)
    if (dup) {
      this.dbg?.log('dedupe', name)
      return dup
    }
    const priority = o.priority ?? false
    this.reclaim(now, priority ? null : name)
    const rate = this.num('rate', o.rate, 1, RATE_MIN, RATE_MAX)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    const peak = this.num('gain', o.gain, 1, 0, GAIN_MAX) * db(def.trim)
    // Short attack ramp from silence: no clicks even when starting mid-file.
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(peak, when + FADE)
    let node: AudioNode = src
    if (o.lowpass) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = this.num('lowpass', o.lowpass, 18_000, 20, ctx.sampleRate * 0.45)
      node.connect(f)
      node = f
    }
    node.connect(g)
    const out = this.route(ctx, g, o)
    out.connect(this.buses[o.bus ?? 'sfx'])
    if (o.reverb) {
      const s = ctx.createGain()
      s.gain.value = this.num('reverb', o.reverb, 0, 0, 1.5)
      out.connect(s)
      s.connect(this.reverbIn)
      s.connect(this.slapIn)
    }
    const start = def.start ?? 0
    // A gridded file played without an offset: one random variant, not the whole run.
    const grid = def.grid && o.offset === undefined ? def.grid : null
    const pick = grid ? Math.floor(Math.random() * grid.count) * grid.step : o.offset
    const offset = start + this.num('offset', pick, 0, 0, Math.max(0, buf.duration - start - 0.02))
    const len = Math.max(
      0.02,
      this.num('duration', o.duration ?? grid?.len, buf.duration - offset, 0, 600),
    )
    const end = when + len / rate
    // Fade the tail too, so sprite slices end cleanly.
    g.gain.setValueAtTime(peak, Math.max(when + FADE, end - 0.02))
    g.gain.linearRampToValueAtTime(0, end)
    src.start(when, offset)
    src.stop(end + 0.01)
    const active: Active = { name, src, gain: g, peak, end, priority, done: false }
    src.onended = () => {
      active.done = true
      src.disconnect()
    }
    this.voices.push(active)
    const voice: Voice = {
      gain: g,
      stop: (at?: number) => {
        active.done = true
        this.fadeStop(g, src, Math.max(at ?? ctx.currentTime, ctx.currentTime))
      },
    }
    const rec = this.starts.get(name)
    if (rec) {
      rec.times.push(when)
      rec.voice = voice
      rec.sig = sig
      rec.last = when
    } else {
      this.starts.set(name, { times: [when], voice, sig, last: when })
    }
    return voice
  }

  /** Spatial (equal-power panner), stereo pan, or straight through. */
  private route(ctx: AudioContext, g: GainNode, o: PlayOpts): AudioNode {
    const pos = o.pos && [o.pos.x, o.pos.y, o.pos.z].every(Number.isFinite) ? o.pos : undefined
    if (o.pos && !pos) {
      this.dbg?.warn('pos', o.pos)
    }
    if (pos) {
      const p = this.panner(ctx, pos)
      g.connect(p)
      return p
    }
    if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = this.num('pan', o.pan, 0, -1, 1)
      g.connect(p)
      return p
    }
    return g
  }

  private panner(ctx: AudioContext, pos: { x: number; y: number; z: number }): PannerNode {
    const p = ctx.createPanner()
    p.panningModel = 'equalpower'
    p.distanceModel = 'inverse'
    p.refDistance = 4
    p.rolloffFactor = 0.7
    p.positionX.value = pos.x
    p.positionY.value = pos.y
    p.positionZ.value = pos.z
    return p
  }

  /**
   * Returns the existing handle when this request re-triggers a sample that is
   * already sounding: the same settings again within RETRIGGER of the previous
   * request (the window slides, so a per-frame caller gets one voice), or past
   * the BURST budget. Otherwise null and the voice plays.
   */
  private retrigger(name: SfxName, sig: string, when: number): Voice | null {
    const rec = this.starts.get(name)
    if (!rec || this.dbg?.raw) {
      return null
    }
    if (rec.sig === sig && Math.abs(when - rec.last) < RETRIGGER) {
      rec.last = Math.max(rec.last, when)
      return rec.voice
    }
    rec.times = rec.times.filter((t) => Math.abs(t - when) < BURST)
    return rec.times.length >= BURST_COUNT ? rec.voice : null
  }

  // ------------------------------------------------------------- named cues

  /** One footstep on `surface` (a random step from its grid), with an optional spur jingle. */
  footstep(surface: 'dirt' | 'wood', o: PlayOpts & { spurs?: boolean } = {}): Voice | null {
    const [name, count, step, len] = STEP[surface]
    const v = this.play(name, {
      ...o,
      offset: Math.floor(Math.random() * count) * step,
      duration: len,
      rate: (o.rate ?? 1) * (0.94 + Math.random() * 0.12),
    })
    if (o.spurs) {
      this.play('spursteps', {
        ...o,
        gain: (o.gain ?? 1) * 0.8,
        offset: Math.floor(Math.random() * SPURS.count) * SPURS.step,
        duration: SPURS.len,
        rate: 0.95 + Math.random() * 0.1,
      })
    }
    return v
  }

  /** A bullet hitting something. */
  impact(surface: keyof typeof IMPACT, o: PlayOpts = {}): Voice | null {
    return this.play(IMPACT[surface], { ...o, rate: (o.rate ?? 1) * (0.92 + Math.random() * 0.16) })
  }

  /** UI sounds: dry, centred, a touch of pitch variety so repeats never machine-gun. */
  ui(name: UiName, gain = 1): Voice | null {
    return this.play(name, { gain, rate: name === 'uiTick' ? 0.94 + Math.random() * 0.12 : 1 })
  }

  // ------------------------------------------------------------- streams

  private stream(spec: { url: string; points?: { start: number; end: number } }): Stream | null {
    const ctx = this.ctx
    if (!(ctx && this.pool)) {
      return null
    }
    const s = new Stream(ctx, this.pool, spec, this.dbg)
    this.streams.add(s)
    this.ticker ??= setInterval(() => this.tickStreams(), 30)
    return s
  }

  private tickStreams(): void {
    for (const s of this.streams) {
      if (s.alive) {
        s.tick()
      } else {
        this.streams.delete(s)
      }
    }
    if (this.streams.size === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  /**
   * A looping bed. Ambience streams from a media element (never decoded); `fuse` loops from its
   * decoded buffer (short, positional, several at once).
   */
  loop(
    name: LoopName,
    gain: number,
    bus: Bus = 'amb',
    pos?: { x: number; y: number; z: number },
  ): Loop | null {
    this.dbg?.log('loop', name, gain, bus)
    if (name in BUFFER_LOOPS) {
      return this.bufferLoop(BUFFER_LOOPS[name as keyof typeof BUFFER_LOOPS], gain, bus, pos)
    }
    const def = LOOPS[name as keyof typeof LOOPS]
    const s = this.stream(def)
    const ctx = this.ctx
    if (!(s && ctx)) {
      return null
    }
    const out = pos ? this.panner(ctx, pos) : null
    if (out) {
      s.out.connect(out).connect(this.buses[bus])
    } else {
      s.out.connect(this.buses[bus])
    }
    const trim = db(def.trim)
    const len = def.points.end - def.points.start
    let target = this.num('loop gain', gain, 0, 0, GAIN_MAX)
    s.start(target * trim, def.points.start + Math.random() * len * 0.8, 1.2)
    return {
      set: (v: number, ramp = 0.3) => {
        const value = this.num('loop gain', v, target, 0, GAIN_MAX)
        if (Math.abs(value - target) < 0.002) {
          return
        }
        target = value
        s.level(value * trim, this.num('loop ramp', ramp, 0.3, 0, 30))
      },
      stop: () => s.stop(1),
    }
  }

  private bufferLoop(
    name: FileName,
    gain: number,
    bus: Bus,
    pos?: { x: number; y: number; z: number },
  ): Loop | null {
    const ctx = this.ctx
    const def = SFX_FILES[name]
    const buf = this.buffers.get(def.url)
    if (!(ctx && buf)) {
      void this.loadPack(def.pack)
      return null
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.loopStart = def.loop?.start ?? 0
    src.loopEnd = def.loop?.end ?? buf.duration
    const g = ctx.createGain()
    const trim = db(def.trim)
    g.gain.setValueAtTime(0, ctx.currentTime)
    g.gain.setTargetAtTime(
      this.num('loop gain', gain, 0, 0, GAIN_MAX) * trim,
      ctx.currentTime,
      0.05,
    )
    src.connect(g)
    const out = pos ? this.panner(ctx, pos) : null
    if (out) {
      g.connect(out).connect(this.buses[bus])
    } else {
      g.connect(this.buses[bus])
    }
    src.start(ctx.currentTime, src.loopStart + Math.random() * (src.loopEnd - src.loopStart))
    let target = gain
    return {
      set: (v: number, ramp = 0.3) => {
        const value = this.num('loop gain', v, target, 0, GAIN_MAX)
        if (Math.abs(value - target) < 0.002) {
          return
        }
        target = value
        glide(g.gain, value * trim, ctx.currentTime, this.num('loop ramp', ramp, 0.3, 0, 30))
      },
      stop: () => {
        const t = ctx.currentTime
        glide(g.gain, 0, t, 0.15)
        src.stop(t + 0.3)
      },
    }
  }

  /**
   * Ambience by time of day (0 morning … 0.6 sunset … 1 midnight): crossfades the day, dusk and
   * night wind beds and brings the crickets in after dark. Beds with nothing to say are stopped,
   * so at most two winds stream at once. `level` scales the whole bed (0 silences it).
   */
  setTimeOfDay(day: number, level = 1): void {
    const d = this.num('day', day, 0, 0, 1)
    const k = this.num('amb level', level, 1, 0, GAIN_MAX)
    const dayW = 1 - smooth((d - 0.42) / 0.22)
    const nightW = smooth((d - 0.7) / 0.18)
    const want = {
      wind: dayW * 0.35,
      windDusk: Math.max(0, 1 - dayW - nightW) * 0.35,
      windNight: nightW * 0.4,
      crickets: smooth((d - 0.68) / 0.2) * 0.35,
    } as const
    for (const key of Object.keys(want) as (keyof typeof want)[]) {
      const v = want[key] * k
      const have = this.beds[key]
      if (v > 0.002) {
        if (have) {
          have.set(v, 1.5)
        } else {
          const l = this.loop(key, v)
          if (l) {
            this.beds[key] = l
          }
        }
      } else if (have) {
        have.stop()
        delete this.beds[key]
      }
    }
  }

  /** Stop the time-of-day beds. */
  stopAmbience(): void {
    for (const l of Object.values(this.beds)) {
      l?.stop()
    }
    this.beds = {}
  }

  /** Synth bullet whizz-by: band-passed noise with a doppler sweep. */
  whizz(pan: number, when?: number): void {
    this.dbg?.log('whizz', pan, when)
    const ctx = this.ctx
    if (!(ctx && this.noise) || this.paused) {
      return
    }
    const t = Math.max(this.num('whizz when', when, 0, 0, ctx.currentTime + 30), ctx.currentTime)
    const side = this.num('whizz pan', pan, 0, -1, 1)
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 6
    f.frequency.setValueAtTime(3800, t)
    f.frequency.exponentialRampToValueAtTime(900, t + 0.22)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(1.2, t + 0.09)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
    const p = ctx.createStereoPanner()
    p.pan.setValueAtTime(-side, t)
    p.pan.linearRampToValueAtTime(side, t + 0.25)
    src.connect(f).connect(g).connect(p).connect(this.buses.sfx)
    src.start(t, Math.random() * 0.5, 0.3)
    src.onended = () => src.disconnect()
    this.play('flyby', { gain: 0.7, pan: side, when: t + 0.06 })
  }

  // ---------------------------------------------------------------- music

  /**
   * Songs stream and loop seamlessly. Switching songs crossfades; asking for the song already
   * playing does nothing, so the track position never restarts; a song you come back to resumes
   * where it left off.
   */
  playSong(name: SongName): void {
    this.dbg?.log('playSong', name, this.song?.name ?? null)
    this.wantSong = name
    if (!this.ctx || this.song?.name === name) {
      return
    }
    const def = SONGS[name]
    const s = this.stream(def)
    if (!s) {
      return
    }
    const old = this.song
    if (old) {
      this.songOffset.set(old.name, old.stream.position)
      old.stream.stop(1.2)
    }
    s.out.connect(this.musicFilter)
    const resume = this.songOffset.get(name) ?? 0
    s.start(db(def.trim), resume < def.points.end ? resume : def.points.start, old ? 1.2 : 0.4)
    this.song = { name, stream: s }
    this.dbg?.log('songStart', name, old?.name ?? null)
  }

  /** The song asked for last (whether or not it is audible yet). */
  get currentSong(): SongName | null {
    return this.wantSong
  }

  /**
   * A victory or defeat sting. It plays on the music bus past the song's duck and lowpass (so it
   * is heard even when the score has been cut), and the song dips under it and swells back.
   */
  playSting(name: StingName): void {
    this.dbg?.log('sting', name)
    const def = STINGS[name]
    this.sting?.stop(0.3)
    const s = this.stream(def)
    if (!s) {
      return
    }
    s.out.connect(this.buses.music)
    s.start(db(def.trim), 0, 0.01)
    this.sting = s
    const song = this.song?.stream
    if (song) {
      song.level(db(SONGS[this.song?.name ?? 'intro'].trim - 14), 0.15)
      setTimeout(() => {
        if (this.song?.stream === song) {
          song.level(db(SONGS[this.song.name].trim), 2)
        }
      }, 5000)
    }
  }

  /** Music level in dB with a ramp in seconds; -Infinity silences. */
  musicLevel(dB: number, ramp = 0.4): void {
    this.dbg?.log('musicLevel', dB, ramp)
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    const gain = dB === Number.NEGATIVE_INFINITY ? 0 : db(this.num('musicLevel', dB, 0, -120, 12))
    glide(this.musicGain.gain, gain, ctx.currentTime, this.num('musicLevel ramp', ramp, 0.4, 0, 30))
  }

  /**
   * The call: the one sound the whole game hinges on, so it is never subject to distance falloff.
   * The bell rings close and centred at full level (with a little reverb for space) while music and
   * ambience duck under it and any heartbeat due in its attack is cancelled, so it is always the
   * loudest, clearest thing you hear.
   */
  call(when?: number): Voice | null {
    const ctx = this.ctx
    if (!ctx) {
      return null
    }
    const at = Math.max(
      this.num('when', when, ctx.currentTime, 0, ctx.currentTime + 30),
      ctx.currentTime,
    )
    for (const [bus, level] of CALL_DUCK) {
      const g = this.buses[bus].gain
      const base = BUS_LEVELS[bus]
      g.cancelScheduledValues(at)
      g.setTargetAtTime(base * level, at, 0.012)
      g.setTargetAtTime(base, at + CALL_DUCK_HOLD, 0.25)
    }
    this.lastCall = at
    for (const h of this.heartVoices) {
      if (h.t > at - 0.03 && h.t < at + CALL_CLEAR) {
        h.v.stop(Math.max(ctx.currentTime, Math.min(h.t, at) - 0.005))
      }
    }
    return this.play('bell', { gain: 1.25, when: at, pan: 0, reverb: 0.35, priority: true })
  }

  /** Lowpass sweep on the music; exponential glide, never a jump. */
  musicLowpass(hz: number, ramp = 0.6): void {
    this.dbg?.log('musicLowpass', hz, ramp)
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    const f = this.num('musicLowpass', hz, 18_000, 40, Math.min(18_000, ctx.sampleRate * 0.45))
    glide(
      this.musicFilter.frequency,
      f,
      ctx.currentTime,
      this.num('musicLowpass ramp', ramp, 0.6, 0, 30),
    )
  }

  // ------------------------------------------------------------ ambience

  /** Heartbeat at the given bpm; 0 stops it. */
  heartbeat(bpm: number): void {
    const b = this.num('heartbeat', bpm, 0, 0, 240)
    if (b > 0 && this.heartBpm === 0) {
      this.heartNext = this.now + 0.05
    }
    this.heartBpm = b
  }

  /** Per-frame: schedules heartbeats a little ahead on the audio clock. */
  update(): void {
    const ctx = this.ctx
    if (!ctx || this.heartBpm <= 0 || this.paused) {
      return
    }
    const now = ctx.currentTime
    // After a hitch or a hidden tab never fire a backlog of beats at once.
    if (this.heartNext < now) {
      this.heartNext = now + 0.02
    }
    const ahead = now + 0.12
    if (this.heartNext < ahead) {
      const t = this.heartNext
      this.heartNext += 60 / this.heartBpm
      // Keep the call's attack clear.
      if (t > this.lastCall - 0.03 && t < this.lastCall + CALL_CLEAR) {
        return
      }
      this.heartVoices.splice(
        0,
        this.heartVoices.length,
        ...this.heartVoices.filter((h) => h.t > now - 1),
      )
      const lub = this.play('heart', { gain: 1.1, when: t, lowpass: 900 })
      const dub = this.play('heart', { gain: 0.6, when: t + 0.16, rate: 0.92, lowpass: 700 })
      for (const [v, at] of [
        [lub, t],
        [dub, t + 0.16],
      ] as const) {
        if (v) {
          this.heartVoices.push({ t: at, v })
        }
      }
    }
  }

  setMono(on: boolean): void {
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    try {
      ctx.destination.channelCount = on ? 1 : Math.min(2, ctx.destination.maxChannelCount)
      ctx.destination.channelCountMode = 'explicit'
    } catch {
      // ignore
    }
  }

  /** Pause: fade the master rather than suspending the context (no glitches on resume). */
  suspend(): void {
    this.dbg?.log('suspend')
    const ctx = this.ctx
    this.paused = true
    if (!ctx) {
      return
    }
    const t = ctx.currentTime
    glide(this.master.gain, 0, t, 0.1)
    for (const v of this.voices) {
      this.fadeStop(v.gain, v.src, t)
    }
    this.voices.length = 0
  }

  resume(): void {
    this.dbg?.log('resume')
    const ctx = this.ctx
    this.paused = false
    if (!ctx) {
      return
    }
    if (ctx.state !== 'running') {
      void ctx.resume()
    }
    glide(this.master.gain, db(-3), ctx.currentTime, 0.2)
  }

  /** Memory and voice counts, for `#audiodebug`. */
  stats(): Record<string, number> {
    let bytes = 0
    for (const b of this.buffers.values()) {
      bytes += b.length * b.numberOfChannels * 4
    }
    return {
      decodedMB: Math.round((bytes / 1_048_576) * 100) / 100,
      buffers: this.buffers.size,
      voices: this.voices.filter((v) => !v.done).length,
      streams: this.streams.size,
      decks: this.pool?.size ?? 0,
      decksBusy: this.pool?.busy ?? 0,
      musicTrimDb: MUSIC_TRIM,
    }
  }
}

/**
 * Soft-clip transfer curve over the WaveShaper's -1..1 input domain: exact
 * identity up to 0.8, then a tanh knee. The limiter sits at -2 dBFS (≈0.79),
 * so in normal play the knee is never reached.
 */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4097
  const knee = 0.8
  const room = 1 - knee
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room)
    curve[i] = Math.sign(x) * y
  }
  return curve
}
