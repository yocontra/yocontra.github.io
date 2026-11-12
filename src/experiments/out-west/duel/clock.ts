import type { DuelOutcome } from '../data/economy.ts'
import { planFakes } from './judge.ts'
import { CALL_FRAME_SLACK_MS } from './pending-call.ts'

const rng = (): number => Math.random()
const between = (a: number, b: number): number => a + (b - a) * rng()

/**
 * Who owns the standoff's timing. The director never knows which clock it
 * has: practice runs on a local clock, ranked runs on the server's.
 */

/** What the director needs to set up one standoff. */
export interface StandoffSpec {
  level: number
  /** Random wait range before the call, ms (ignored when `sequence` is set). */
  waitMs: readonly [number, number]
  fakeChance: number
  maxFakes: number
  /** Fake-out cue names this outlaw can use. */
  cues: readonly string[]
  /** Cues that always play once, somewhere in the wait (the piano always stops). */
  forced: readonly string[]
  /** Cues played in order before the call (the boss's clock). */
  sequence: { cues: readonly string[]; intervalMs: readonly [number, number] } | null
  /** Playing by touch: the outlaw's draw gets the touch allowance (`TOUCH_ALLOWANCE_MS`). */
  touch: boolean
}

/** The server's (or the local judge's) verdict on a duel. */
export interface Verdict {
  duel: number
  outcome: DuelOutcome
  reactionMs: number | null
  enemyMs: number | null
  payout: number
  purse: number
  targetsHit: number
}

export interface ClockEvents {
  /** A fake-out or atmosphere cue. */
  cue: (duel: number, cue: string) => void
  /** The real call, handled now. */
  call: (duel: number) => void
  /** A verdict from the server (ranked only). */
  verdict: (v: Verdict) => void
  /** The ranked connection is gone: carry on in practice. */
  dropped: (reason: string) => void
  /** Ranked only: the link dropped and is being resumed (true), or is back (false). */
  reconnecting: (on: boolean) => void
  /**
   * Ranked only: back on the same run after a drop. Any standoff that was in flight was voided
   * unjudged, so a live standoff must be run again (`purse` is the server's run total).
   */
  resumed: (purse: number) => void
}

export interface DuelClock {
  /** True when the server owns timing and judging. */
  readonly ranked: boolean
  /** Start the standoff for a new attempt; returns its duel id. */
  standoff: (spec: StandoffSpec) => number
  /** perf time of the coming call when known ahead (practice only), else null. */
  callAt: () => number | null
  /** Per frame. */
  tick: (now: number) => void
  /** A shot by the player: target index, ms since the call (null before the call). */
  shot: (target: number, localMs: number | null) => void
  /** Void the current standoff (practice: pausing re-rolls the wait). */
  cancel: () => void
  dispose: () => void
}

const noop = (): void => undefined

interface Timed {
  at: number
  cue: string
  fired: boolean
}

/** Practice: the wait, fake-outs and the call are rolled here, in the browser. */
export class LocalDuelClock implements DuelClock {
  readonly ranked = false as boolean
  private readonly events: ClockEvents
  private duel = -1
  private live = false as boolean
  private tCall = 0
  private timed: Timed[] = []

  constructor(events: ClockEvents) {
    this.events = events
  }

  standoff(spec: StandoffSpec): number {
    this.duel++
    const now = performance.now()
    const timed: Timed[] = []
    let callIn: number
    if (spec.sequence) {
      let at = 0
      for (const cue of spec.sequence.cues) {
        at += between(spec.sequence.intervalMs[0], spec.sequence.intervalMs[1])
        timed.push({ at, cue, fired: false })
      }
      callIn = at + between(spec.sequence.intervalMs[0], spec.sequence.intervalMs[1])
    } else {
      callIn = between(spec.waitMs[0], spec.waitMs[1])
    }
    for (const at of planFakes(callIn, spec.fakeChance, spec.maxFakes, rng)) {
      const cue = spec.cues[Math.floor(rng() * spec.cues.length)]
      if (cue !== undefined) {
        timed.push({ at, cue, fired: false })
      }
    }
    for (const cue of spec.forced) {
      if (!timed.some((t) => t.cue === cue)) {
        timed.push({ at: between(0.4, 0.75) * callIn, cue, fired: false })
      }
    }
    this.timed = timed.sort((a, b) => a.at - b.at).map((t) => ({ ...t, at: now + t.at }))
    this.tCall = now + callIn
    this.live = true
    return this.duel
  }

  callAt(): number | null {
    return this.live ? this.tCall : null
  }

  tick(now: number): void {
    if (!this.live) {
      return
    }
    for (const t of this.timed) {
      if (!t.fired && now >= t.at) {
        t.fired = true
        this.events.cue(this.duel, t.cue)
      }
    }
    // the call: the first frame at/after tCall (within half a frame)
    if (now >= this.tCall - CALL_FRAME_SLACK_MS) {
      this.live = false
      this.events.call(this.duel)
    }
  }

  /** Practice shots are judged locally by the director. */
  readonly shot: DuelClock['shot'] = noop

  cancel(): void {
    this.live = false
  }

  dispose(): void {
    this.live = false
  }
}
