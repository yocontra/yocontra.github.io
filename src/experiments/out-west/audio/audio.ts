// biome-ignore-all lint/complexity/useMaxParams: geometry/audio builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one cohesive module (data table / scene builder); splitting would scatter tightly coupled code. Tracked for a later split.
// biome-ignore-all lint/style/useThisInClassMethods: interface methods that are deliberate no-ops for this implementation
// biome-ignore-all lint/suspicious/noShadow: local name mirrors the field it configures
/**
 * Web Audio mix (design doc §4.5). One AudioContext for everything:
 *
 *   voices ─┬─ sfx bus ─┐
 *           ├─ reverb + slap-back ─┤
 *   loops ──── amb bus ─┼─ master ─ glue comp ─ limiter ─ soft clip ─ out
 *   music ─ lowpass ─ level ─ music bus ─┘
 *
 * Every sound (music included) is fully decoded before use; nothing decodes
 * mid-duel. Voices come from a capped pool, and every start and stop runs a
 * short gain ramp so nothing clicks.
 */

import { AudioDebug, audioDebugMode } from './debug.ts'

const OLD = '/experiments/out-west/assets'
const NEW = '/experiments/out-west/3d/sfx'

export const SFX = {
  cocking: `${OLD}/cocking.m4a`,
  fire: `${OLD}/fire.m4a`,
  fireBig: `${OLD}/fire-big.m4a`,
  shout: `${OLD}/shout.m4a`,
  whip: `${OLD}/whip.m4a`,
  bell: `${NEW}/bell.m4a`,
  heart: `${NEW}/heart.m4a`,
  spursteps: `${NEW}/spursteps.m4a`,
  dirtsteps: `${NEW}/dirtsteps.m4a`,
  ricochet: `${NEW}/ricochet.m4a`,
  flyby: `${NEW}/flyby.m4a`,
  bodyfall: `${NEW}/bodyfall.m4a`,
  gasp: `${NEW}/gasp.m4a`,
  crow: `${NEW}/crow.m4a`,
  door: `${NEW}/door.m4a`,
  bottle: `${NEW}/bottle.m4a`,
  horse: `${NEW}/horse.m4a`,
  coin: `${NEW}/coin.m4a`,
  piano: `${NEW}/piano.m4a`,
  dog: `${NEW}/dog.m4a`,
  hawk: `${NEW}/hawk.m4a`,
  holster: `${NEW}/holster.m4a`,
  wind: `${NEW}/wind.m4a`,
  crickets: `${NEW}/crickets.m4a`,
  fire_loop: `${NEW}/fire.m4a`,
} as const

export type SfxName = keyof typeof SFX
export type Bus = 'sfx' | 'amb' | 'music'

export const SONGS = {
  intro: `${OLD}/intro.m4a`,
  boss: `${OLD}/boss.m4a`,
} as const
export type SongName = keyof typeof SONGS

/** Resting bus levels. */
const BUS_LEVELS: Readonly<Record<Bus, number>> = { sfx: 0.72, amb: 0.5, music: 1.15 }
/** How far each bus ducks under the call (linear gain multiplier). */
const CALL_DUCK: readonly (readonly [Bus, number])[] = [
  ['music', 0.18],
  ['amb', 0.25],
]
/** Seconds the duck holds before music and ambience swell back. */
const CALL_DUCK_HOLD = 0.7

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

export class AudioEngine {
  ctx: AudioContext | null = null
  private master!: GainNode
  private buses!: Record<Bus, GainNode>
  private musicFilter!: BiquadFilterNode
  private musicGain!: GainNode
  private reverbIn!: GainNode
  private slapIn!: GainNode
  private readonly raw = new Map<string, Promise<ArrayBuffer | null>>()
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>()
  private readonly voices: Active[] = []
  private song: { name: SongName; src: AudioBufferSourceNode; gain: GainNode } | null = null
  private wantSong: SongName | null = null
  private readonly songOffset = new Map<SongName, { startedAt: number; offset: number }>()
  private heartBpm = 0
  private heartNext = 0
  private noise: AudioBuffer | null = null
  private paused = false
  private dbg: AudioDebug | null = null
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

  /** Start fetching every sound (and the intro music) before the first gesture. */
  prefetch(): void {
    for (const key of Object.keys(SFX) as SfxName[]) {
      this.fetchRaw(SFX[key])
    }
    this.fetchRaw(SONGS.intro)
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
      if (!data) {
        return null
      }
      try {
        const b = await ctx.decodeAudioData(data.slice(0))
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
    this.dbg = mode === null ? null : new AudioDebug(ctx, mode)
    this.dbg?.log('unlock', ctx.sampleRate)

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
      this.dbg.tap('music', this.musicGain)
      this.dbg.tap('sfx', this.buses.sfx)
      this.dbg.tap('amb', this.buses.amb)
    }

    this.noise = this.makeNoise(ctx, 1)

    for (const key of Object.keys(SFX) as SfxName[]) {
      void this.decode(SFX[key])
    }
    void this.decode(SONGS.intro)
  }

  /** Resolves once every sound effect (and the intro) has decoded or failed. */
  async whenDecoded(timeoutMs = 6000): Promise<void> {
    const all = Promise.all([...this.decoding.values()])
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /** Decode the boss music ahead of time (called a few outlaws early). */
  preloadSong(name: SongName): void {
    if (this.ctx) {
      void this.decode(SONGS[name])
    } else {
      this.fetchRaw(SONGS[name])
    }
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
    return this.buffers.has(SFX[name])
  }

  duration(name: SfxName): number {
    return this.buffers.get(SFX[name])?.duration ?? 0
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

  play(name: SfxName, o: PlayOpts = {}): Voice | null {
    const ctx = this.ctx
    const buf = this.buffers.get(SFX[name])
    this.dbg?.log('play', name, o)
    if (!(ctx && buf) || this.paused) {
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
    const priority = o.priority ?? (name === 'bell' || name === 'fire' || name === 'fireBig')
    this.reclaim(now, priority ? null : name)
    const rate = this.num('rate', o.rate, 1, RATE_MIN, RATE_MAX)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    const peak = this.num('gain', o.gain, 1, 0, GAIN_MAX)
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
    let out: AudioNode = g
    const pos = o.pos && [o.pos.x, o.pos.y, o.pos.z].every(Number.isFinite) ? o.pos : undefined
    if (o.pos && !pos) {
      this.dbg?.warn('pos', o.pos)
    }
    if (pos) {
      const p = ctx.createPanner()
      p.panningModel = 'equalpower'
      p.distanceModel = 'inverse'
      p.refDistance = 4
      p.rolloffFactor = 0.7
      p.positionX.value = pos.x
      p.positionY.value = pos.y
      p.positionZ.value = pos.z
      g.connect(p)
      out = p
    } else if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = this.num('pan', o.pan, 0, -1, 1)
      g.connect(p)
      out = p
    }
    out.connect(this.buses[o.bus ?? 'sfx'])
    if (o.reverb) {
      const s = ctx.createGain()
      s.gain.value = this.num('reverb', o.reverb, 0, 0, 1.5)
      out.connect(s)
      s.connect(this.reverbIn)
      s.connect(this.slapIn)
    }
    const offset = this.num('offset', o.offset, 0, 0, Math.max(0, buf.duration - 0.02))
    const len = Math.max(0.02, this.num('duration', o.duration, buf.duration - offset, 0, 600))
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

  loop(name: SfxName, gain: number, bus: Bus = 'amb'): Loop | null {
    this.dbg?.log('loop', name, gain, bus)
    const ctx = this.ctx
    const buf = this.buffers.get(SFX[name])
    if (!(ctx && buf)) {
      return null
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    // Skip AAC priming at both ends so the loop point is seamless.
    src.loopStart = 0.06
    src.loopEnd = buf.duration - 0.06
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, ctx.currentTime)
    g.gain.setTargetAtTime(this.num('loop gain', gain, 0, 0, GAIN_MAX), ctx.currentTime, 0.5)
    src.connect(g).connect(this.buses[bus])
    src.start(ctx.currentTime, 0.06 + Math.random() * (buf.duration * 0.5))
    let target = gain
    return {
      set: (v: number, ramp = 0.3) => {
        const value = this.num('loop gain', v, target, 0, GAIN_MAX)
        if (Math.abs(value - target) < 0.002) {
          return
        }
        target = value
        glide(g.gain, value, ctx.currentTime, this.num('loop ramp', ramp, 0.3, 0, 30))
      },
      stop: () => {
        const t = ctx.currentTime
        g.gain.cancelScheduledValues(t)
        g.gain.setTargetAtTime(0, t, 0.2)
        src.stop(t + 1.2)
      },
    }
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
   * Music is a decoded, looping buffer per song. Switching songs crossfades;
   * asking for the song already playing does nothing, so the track position
   * never restarts.
   */
  playSong(name: SongName): void {
    this.dbg?.log('playSong', name, this.song?.name ?? null)
    this.wantSong = name
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    if (this.song?.name === name) {
      return
    }
    void this.decode(SONGS[name]).then((buf) => {
      if (!buf || this.wantSong !== name || this.song?.name === name) {
        return
      }
      const t = ctx.currentTime
      const old = this.song
      if (old) {
        glide(old.gain.gain, 0, t, 1.2)
        old.src.stop(t + 1.6)
        const st = this.songOffset.get(old.name)
        if (st) {
          st.offset = (st.offset + (t - st.startedAt)) % (old.src.buffer?.duration ?? 1)
        }
      }
      this.dbg?.log('songStart', name, old?.name ?? null)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(1, t + (old ? 1.2 : 0.4))
      src.connect(g).connect(this.musicFilter)
      const resumeAt = this.songOffset.get(name)?.offset ?? 0
      src.start(t, resumeAt)
      this.songOffset.set(name, { startedAt: t, offset: resumeAt })
      this.song = { name, src, gain: g }
    })
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
   * ambience duck under it, so it is always the loudest, clearest thing you hear.
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
      this.play('heart', { gain: 1.1, when: t, lowpass: 900 })
      this.play('heart', { gain: 0.6, when: t + 0.16, rate: 0.92, lowpass: 700 })
      this.heartNext += 60 / this.heartBpm
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
