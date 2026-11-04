/**
 * Input timing: keeps this client's 20 Hz input ticks running just far enough ahead of the
 * server's consumption that every frame arrives before the tick that applies it.
 *
 * The server's input queue applies one numbered frame per tick and, for a number it hasn't
 * received, repeats the last frame (silence means unchanged). A frame that arrives after its number
 * was consumed is applied a tick late with the wrong number, and the prediction is wrong by a
 * tick of movement. Each snapshot echoes how early the newest input message arrived (`inputLead`,
 * in frames: how many ticks before its first frame would be consumed). This clock watches the
 * worst lead over the last two seconds (so it adapts to jitter) and holds it in a band of 1–3
 * frames (50–150 ms of margin):
 * - Too close: ticks run up to 6% faster until the margin is back.
 * - Too far ahead (extra latency): up to 3% slower.
 * - Hopelessly late (the tab was hidden, a long stall): skip frame numbers forward at once. The
 *   server has already repeated those frames, so the jump arrives as one smoothed correction.
 * The rate change is far below what the eye notices (the walk speeds up by at most 0.3 m/s).
 */
import { TICK_MS } from '../sim/constants.ts'

const WINDOW_MS = 2000
/** Lead band (frames) for the window's worst arrival. */
const LEAD_LO = 1
const LEAD_HI = 3
/** Late by this many frames or more: skip ahead rather than catch up slowly. */
const SKIP_AT = -3
const MAX_FAST = 0.06
const MAX_SLOW = 0.03
const MAX_SAMPLES = 64

export class TickClock {
  /** The current input tick period (ms). */
  period = TICK_MS
  /** Worst lead in the window (frames), for the perf overlay and the trace. */
  worst = 0
  private readonly at = new Float64Array(MAX_SAMPLES)
  private readonly lead = new Int16Array(MAX_SAMPLES)
  private head = 0
  private count = 0
  private holdUntil = 0

  /**
   * One snapshot's `inputLead` (frames, or null when no input arrived since the last snapshot).
   * Returns how many frame numbers to skip forward (0 normally).
   */
  observe(lead: number | null, nowMs: number): number {
    if (lead !== null) {
      this.at[this.head] = nowMs
      this.lead[this.head] = lead
      this.head = (this.head + 1) % MAX_SAMPLES
      this.count = Math.min(MAX_SAMPLES, this.count + 1)
    }
    if (nowMs < this.holdUntil) {
      // A skip or a big rate change takes a round trip to show in the leads.
      return 0
    }
    let worst = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.count; i++) {
      if (nowMs - (this.at[i] ?? 0) <= WINDOW_MS) {
        worst = Math.min(worst, this.lead[i] ?? 0)
      }
    }
    if (worst === Number.POSITIVE_INFINITY) {
      this.period = TICK_MS
      return 0
    }
    this.worst = worst
    if (lead !== null && lead <= SKIP_AT) {
      this.count = 0
      this.period = TICK_MS
      this.holdUntil = nowMs + 1000
      return LEAD_LO + 1 - lead
    }
    if (worst < LEAD_LO) {
      this.period = TICK_MS * (1 - Math.min(MAX_FAST, 0.02 * (LEAD_LO - worst)))
    } else if (worst > LEAD_HI) {
      this.period = TICK_MS * (1 + Math.min(MAX_SLOW, 0.01 * (worst - LEAD_HI)))
    } else {
      this.period = TICK_MS
    }
    return 0
  }

  reset(): void {
    this.count = 0
    this.period = TICK_MS
    this.holdUntil = 0
  }
}
