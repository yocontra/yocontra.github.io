/**
 * Streamed audio: music and ambience beds play from `<audio>` elements routed into the Web Audio
 * graph (MediaElementAudioSourceNode), so they are never decoded into memory (spec §9.3: a minute
 * of decoded stereo is ~23 MB).
 *
 * Gapless looping without decoding: each looped file is [lead-in | body | the body's first seconds
 * again] (`tools/audio/build.ts`). A stream owns two decks. About a second before the playing deck
 * reaches the loop end, the other deck starts, silent, at the matching spot just before the loop
 * start; its playbackRate is nudged (±5%, inaudible while silent) until both decks are at the same
 * musical position, then a 60 ms equal-power crossfade on the AudioContext clock hands over at the
 * loop point. Both decks play identical audio there, so the seam is inaudible.
 *
 */

import type { Deck, DeckPool } from './deck-pool.ts'

export interface StreamSpec {
  url: string
  points?: { start: number; end: number } | undefined
}

/** How early the next deck starts before the loop end, seconds. */
const LEAD = 1.2
/** Crossfade at the loop point, seconds. */
const XF = 0.06
/** Hand over once the loop end is this close. */
const SCHEDULE = 0.12
const RATE_NUDGE = 0.05
/** Each looped file carries this much audio past its loop end (`tools/audio/build.ts`). */
const POST_ROLL = 1.5

function load(d: Deck, url: string, at: number): void {
  if (d.el.dataset.url !== url) {
    d.el.dataset.url = url
    d.el.src = url
  }
  d.el.currentTime = Math.max(0, at)
}

function curve(up: boolean): Float32Array<ArrayBuffer> {
  const n = 32
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    c[i] = up ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2)
  }
  return c
}

export interface StreamDebug {
  log: (name: string, ...args: unknown[]) => void
}

/** One streamed sound: a looping bed or song, or a one-shot sting. */
export class Stream {
  /** Stream level; connect this to a bus (or a panner). */
  readonly out: GainNode
  readonly spec: StreamSpec
  private readonly ctx: AudioContext
  private readonly pool: DeckPool
  private a: Deck | null = null
  private b: Deck | null = null
  private handoverAt = 0
  private dead: boolean
  private wasPlaying: boolean
  private readonly dbg: StreamDebug | null

  constructor(ctx: AudioContext, pool: DeckPool, spec: StreamSpec, dbg: StreamDebug | null) {
    this.ctx = ctx
    this.pool = pool
    this.spec = spec
    this.dbg = dbg
    this.dead = false
    this.wasPlaying = false
    this.out = ctx.createGain()
    this.out.gain.value = 0
  }

  get alive(): boolean {
    return !this.dead
  }

  /** Seconds into the file of the deck you hear. */
  get position(): number {
    return this.a?.el.currentTime ?? 0
  }

  start(level: number, offset = 0, fadeIn = 0.4): void {
    const d = this.pool.take()
    d.gain.connect(this.out)
    d.gain.gain.value = 1
    load(d, this.spec.url, offset)
    this.play(d)
    this.a = d
    const t = this.ctx.currentTime
    this.out.gain.cancelScheduledValues(t)
    this.out.gain.setValueAtTime(0, t)
    this.out.gain.linearRampToValueAtTime(level, t + Math.max(0.01, fadeIn))
  }

  private play(d: Deck): void {
    d.el.play().catch((e: unknown) => this.dbg?.log('streamBlocked', this.spec.url, String(e)))
  }

  level(v: number, ramp = 0.3): void {
    const t = this.ctx.currentTime
    const p = this.out.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
    if (p.cancelAndHoldAtTime) {
      p.cancelAndHoldAtTime(t)
    } else {
      p.cancelScheduledValues(t)
      p.setValueAtTime(p.value, t)
    }
    p.setTargetAtTime(v, t, Math.max(0.01, ramp / 4))
  }

  stop(fade = 1): void {
    if (this.dead) {
      return
    }
    this.dead = true
    this.level(0, fade)
    const decks = [this.a, this.b]
    this.a = null
    this.b = null
    setTimeout(
      () => {
        for (const d of decks) {
          if (d) {
            this.pool.give(d)
          }
        }
        this.out.disconnect()
      },
      (fade + 0.3) * 1000,
    )
  }

  /** Page hidden: pause without losing place. */
  pause(): void {
    this.wasPlaying = this.a !== null && !this.a.el.paused
    this.a?.el.pause()
    if (this.b) {
      this.pool.give(this.b)
      this.b = null
      this.handoverAt = 0
    }
  }

  resume(): void {
    if (this.wasPlaying && this.a && !this.dead) {
      this.play(this.a)
    }
  }

  /** A gesture arrived: start a deck the browser refused to start earlier. */
  retry(): void {
    if (this.a?.el.paused && !this.dead && !this.a.el.ended) {
      this.play(this.a)
    }
  }

  /** Called every ~30 ms by the engine's scheduler. */
  tick(): void {
    const a = this.a
    if (this.dead || !a) {
      return
    }
    const pts = this.spec.points
    if (!pts) {
      if (a.el.ended) {
        this.stop(0.05)
      }
      return
    }
    if (a.el.ended) {
      // Missed the handover entirely (a long stall): restart at the loop.
      load(a, this.spec.url, pts.start)
      this.play(a)
      return
    }
    if (this.handoverAt > 0) {
      if (this.ctx.currentTime > this.handoverAt + 0.05) {
        this.finishHandover()
      }
      return
    }
    const t = a.el.currentTime
    const remaining = pts.end - t
    if (!this.b && remaining <= LEAD && remaining > -0.5) {
      const b = this.pool.take()
      b.gain.connect(this.out)
      b.gain.gain.value = 0
      load(b, this.spec.url, pts.start - remaining)
      this.play(b)
      this.b = b
      return
    }
    if (this.b) {
      this.steer(this.b, a, remaining)
    }
  }

  /** Keep the incoming deck at the same musical position, then cross over at the loop point. */
  private steer(b: Deck, a: Deck, remaining: number): void {
    const pts = this.spec.points
    if (!pts) {
      return
    }
    const ready = !b.el.paused && b.el.readyState >= 3
    const err = b.el.currentTime - pts.start - (a.el.currentTime - pts.end)
    if (!ready) {
      // The outgoing deck runs on into its post-roll (identical to the loop start), so wait.
      if (remaining > -POST_ROLL) {
        return
      }
    } else if (remaining > SCHEDULE + 0.05) {
      b.el.playbackRate = Math.min(1 + RATE_NUDGE, Math.max(1 - RATE_NUDGE, 1 - err / remaining))
      return
    } else if (remaining > SCHEDULE) {
      return
    }
    b.el.playbackRate = 1
    const now = this.ctx.currentTime
    // Centre the crossfade just after the loop end: from there on both decks play identical audio.
    const start = Math.max(now, now + remaining + 0.02 - XF / 2)
    a.gain.gain.cancelScheduledValues(now)
    a.gain.gain.setValueCurveAtTime(curve(false), start, XF)
    b.gain.gain.cancelScheduledValues(now)
    b.gain.gain.setValueCurveAtTime(curve(true), start, XF)
    this.handoverAt = start + XF
    this.dbg?.log('loopSeam', this.spec.url.split('/').pop(), Math.round(err * 1000), ready)
  }

  private finishHandover(): void {
    const old = this.a
    this.a = this.b
    this.b = null
    this.handoverAt = 0
    if (old) {
      this.pool.give(old)
    }
  }
}
