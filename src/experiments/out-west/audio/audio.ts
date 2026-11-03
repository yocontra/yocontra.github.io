/**
 * Web Audio mix (design doc §4.5). One AudioContext for everything:
 *
 *   voices ─┬─ sfx bus ─┐
 *           ├─ reverb + slap-back ─┤
 *   loops ──── amb bus ─┼─ master ─ glue compressor ─ brickwall limiter ─ out
 *   music ─ lowpass ─ level ─ music bus ─┘
 *
 * Every sound (music included) is fully decoded before use; nothing decodes
 * mid-duel. Voices come from a capped pool, and every start and stop runs a
 * short gain ramp so nothing clicks.
 */

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
  stop(at?: number): void
  readonly gain: GainNode
}

export interface Loop {
  set(value: number, ramp?: number): void
  stop(): void
}

interface Active {
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
  const hold = (p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam })
    .cancelAndHoldAtTime
  if (hold) hold.call(p, now)
  else {
    p.cancelScheduledValues(now)
    p.setValueAtTime(p.value, now)
  }
  p.setTargetAtTime(target, now, Math.max(0.01, seconds / 4))
}
/** Max simultaneous one-shot voices. */
const MAX_VOICES = 24
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
  private songOffset = new Map<SongName, { startedAt: number; offset: number }>()
  private heartBpm = 0
  private heartNext = 0
  private noise: AudioBuffer | null = null
  private paused = false

  /** Start fetching every sound (and the intro music) before the first gesture. */
  prefetch(): void {
    for (const key of Object.keys(SFX) as SfxName[]) this.fetchRaw(SFX[key])
    this.fetchRaw(SONGS.intro)
  }

  private fetchRaw(url: string): Promise<ArrayBuffer | null> {
    const have = this.raw.get(url)
    if (have) return have
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
    this.raw.set(url, p)
    return p
  }

  private decode(url: string): Promise<AudioBuffer | null> {
    const have = this.decoding.get(url)
    if (have) return have
    const ctx = this.ctx
    if (!ctx) return Promise.resolve(null)
    const p = this.fetchRaw(url).then(async (data) => {
      if (!data) return null
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
      if (this.ctx.state !== 'running') void this.ctx.resume()
      return
    }
    const Ctor = window.AudioContext
    if (!Ctor) return
    const ctx = new Ctor({ latencyHint: 'interactive' })
    this.ctx = ctx
    void ctx.resume()

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
    this.master.connect(glue).connect(trim).connect(limiter).connect(ctx.destination)

    const mk = (v: number) => {
      const g = ctx.createGain()
      g.gain.value = v
      g.connect(this.master)
      return g
    }
    this.buses = { sfx: mk(0.72), amb: mk(0.5), music: mk(1.15) }

    this.musicFilter = ctx.createBiquadFilter()
    this.musicFilter.type = 'lowpass'
    this.musicFilter.frequency.value = 18000
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

    this.noise = this.makeNoise(ctx, 1)

    for (const key of Object.keys(SFX) as SfxName[]) void this.decode(SFX[key])
    void this.decode(SONGS.intro)
  }

  /** Resolves once every sound effect (and the intro) has decoded or failed. */
  async whenDecoded(timeoutMs = 6000): Promise<void> {
    const all = Promise.all([...this.decoding.values()])
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /** Decode the boss music ahead of time (called a few outlaws early). */
  preloadSong(name: SongName): void {
    if (this.ctx) void this.decode(SONGS[name])
    else this.fetchRaw(SONGS[name])
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
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    return buf
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0
  }

  /** Map a performance.now() timestamp to the AudioContext clock (output-latency aware). */
  perfToCtx(perfMs: number): number {
    const ctx = this.ctx
    if (!ctx) return 0
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
    if (!ctx) return
    const l = ctx.listener
    if (!l.positionX) return
    l.positionX.value = px
    l.positionY.value = py
    l.positionZ.value = pz
    l.forwardX.value = fx
    l.forwardY.value = fy
    l.forwardZ.value = fz
    l.upX.value = 0
    l.upY.value = 1
    l.upZ.value = 0
  }

  has(name: SfxName): boolean {
    return this.buffers.has(SFX[name])
  }

  duration(name: SfxName): number {
    return this.buffers.get(SFX[name])?.duration ?? 0
  }

  /** Free a pool slot: fade out the oldest non-priority voice. */
  private reclaim(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i]
      if (v && (v.done || v.end < now)) this.voices.splice(i, 1)
    }
    while (this.voices.length >= MAX_VOICES) {
      const idx = this.voices.findIndex((v) => !v.priority)
      const v = this.voices.splice(Math.max(idx, 0), 1)[0]
      if (v) this.fadeStop(v.gain, v.src, now)
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
    if (!ctx || !buf || this.paused) return null
    const now = ctx.currentTime
    this.reclaim(now)
    const when = Math.max(o.when ?? 0, now)
    const rate = o.rate ?? 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    const peak = o.gain ?? 1
    // Short attack ramp from silence: no clicks even when starting mid-file.
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(peak, when + FADE)
    let node: AudioNode = src
    if (o.lowpass) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = o.lowpass
      node.connect(f)
      node = f
    }
    node.connect(g)
    let out: AudioNode = g
    if (o.pos) {
      const p = ctx.createPanner()
      p.panningModel = 'equalpower'
      p.distanceModel = 'inverse'
      p.refDistance = 4
      p.rolloffFactor = 0.7
      p.positionX.value = o.pos.x
      p.positionY.value = o.pos.y
      p.positionZ.value = o.pos.z
      g.connect(p)
      out = p
    } else if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = o.pan
      g.connect(p)
      out = p
    }
    out.connect(this.buses[o.bus ?? 'sfx'])
    if (o.reverb) {
      const s = ctx.createGain()
      s.gain.value = o.reverb
      out.connect(s)
      s.connect(this.reverbIn)
      s.connect(this.slapIn)
    }
    const offset = o.offset ?? 0
    const len = Math.max(0.02, o.duration ?? buf.duration - offset)
    const end = when + len / rate
    // Fade the tail too, so sprite slices end cleanly.
    g.gain.setValueAtTime(peak, Math.max(when + FADE, end - 0.02))
    g.gain.linearRampToValueAtTime(0, end)
    src.start(when, offset)
    src.stop(end + 0.01)
    const priority = o.priority ?? (name === 'bell' || name === 'fire' || name === 'fireBig')
    const active: Active = { src, gain: g, peak, end, priority, done: false }
    src.onended = () => {
      active.done = true
      src.disconnect()
    }
    this.voices.push(active)
    return {
      gain: g,
      stop: (at?: number) => {
        active.done = true
        this.fadeStop(g, src, Math.max(at ?? ctx.currentTime, ctx.currentTime))
      },
    }
  }

  loop(name: SfxName, gain: number, bus: Bus = 'amb'): Loop | null {
    const ctx = this.ctx
    const buf = this.buffers.get(SFX[name])
    if (!ctx || !buf) return null
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    // Skip AAC priming at both ends so the loop point is seamless.
    src.loopStart = 0.06
    src.loopEnd = buf.duration - 0.06
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, ctx.currentTime)
    g.gain.setTargetAtTime(gain, ctx.currentTime, 0.5)
    src.connect(g).connect(this.buses[bus])
    src.start(ctx.currentTime, 0.06 + Math.random() * (buf.duration * 0.5))
    let target = gain
    return {
      set: (v: number, ramp = 0.3) => {
        if (Math.abs(v - target) < 0.002) return
        target = v
        glide(g.gain, v, ctx.currentTime, ramp)
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
    const ctx = this.ctx
    if (!ctx || !this.noise || this.paused) return
    const t = Math.max(when ?? 0, ctx.currentTime)
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
    p.pan.setValueAtTime(-pan, t)
    p.pan.linearRampToValueAtTime(pan, t + 0.25)
    src.connect(f).connect(g).connect(p).connect(this.buses.sfx)
    src.start(t, Math.random() * 0.5, 0.3)
    src.onended = () => src.disconnect()
    this.play('flyby', { gain: 0.7, pan, when: t + 0.06 })
  }

  // ---------------------------------------------------------------- music

  /**
   * Music is a decoded, looping buffer per song. Switching songs crossfades;
   * asking for the song already playing does nothing, so the track position
   * never restarts.
   */
  playSong(name: SongName): void {
    this.wantSong = name
    const ctx = this.ctx
    if (!ctx) return
    if (this.song?.name === name) return
    void this.decode(SONGS[name]).then((buf) => {
      if (!buf || this.wantSong !== name || this.song?.name === name) return
      const t = ctx.currentTime
      const old = this.song
      if (old) {
        glide(old.gain.gain, 0, t, 1.2)
        old.src.stop(t + 1.6)
        const st = this.songOffset.get(old.name)
        if (st) st.offset = (st.offset + (t - st.startedAt)) % (old.src.buffer?.duration ?? 1)
      }
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
    const ctx = this.ctx
    if (!ctx) return
    glide(this.musicGain.gain, dB === -Infinity ? 0 : db(dB), ctx.currentTime, ramp)
  }

  /** Lowpass sweep on the music; exponential glide, never a jump. */
  musicLowpass(hz: number, ramp = 0.6): void {
    const ctx = this.ctx
    if (!ctx) return
    glide(this.musicFilter.frequency, hz, ctx.currentTime, ramp)
  }

  // ------------------------------------------------------------ ambience

  /** Heartbeat at the given bpm; 0 stops it. */
  heartbeat(bpm: number): void {
    if (bpm > 0 && this.heartBpm === 0) this.heartNext = this.now + 0.05
    this.heartBpm = bpm
  }

  /** Per-frame: schedules heartbeats a little ahead on the audio clock. */
  update(): void {
    const ctx = this.ctx
    if (!ctx || this.heartBpm <= 0 || this.paused) return
    const now = ctx.currentTime
    // After a hitch or a hidden tab never fire a backlog of beats at once.
    if (this.heartNext < now) this.heartNext = now + 0.02
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
    if (!ctx) return
    try {
      ctx.destination.channelCount = on ? 1 : Math.min(2, ctx.destination.maxChannelCount)
      ctx.destination.channelCountMode = 'explicit'
    } catch {
      // ignore
    }
  }

  /** Pause: fade the master rather than suspending the context (no glitches on resume). */
  suspend(): void {
    const ctx = this.ctx
    this.paused = true
    if (!ctx) return
    const t = ctx.currentTime
    glide(this.master.gain, 0, t, 0.1)
    for (const v of this.voices) this.fadeStop(v.gain, v.src, t)
    this.voices.length = 0
  }

  resume(): void {
    const ctx = this.ctx
    this.paused = false
    if (!ctx) return
    if (ctx.state !== 'running') void ctx.resume()
    glide(this.master.gain, db(-3), ctx.currentTime, 0.2)
  }
}
