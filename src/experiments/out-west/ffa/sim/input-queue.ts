/**
 * The lobby's jitter buffer for one player's send-on-change input (see `input.ts` for the
 * protocol): it consumes frame `expect` each tick, replays the last frame through silence, keeps
 * late button presses and fast-forwards a client that runs too far ahead.
 */
import type { WireFrame } from './codec.ts'
import { EDGE_BUTTONS, INPUT_BUFFER_FRAMES, MAX_AHEAD_FRAMES, seqDiff } from './input.ts'

/** Server side: one per player. */
export class InputQueue {
  private readonly pending = new Map<number, WireFrame>()
  private expect = -1
  private last: WireFrame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }
  private late: WireFrame | null = null
  private edges: number

  constructor() {
    this.edges = 0
  }
  /** Frames dropped as too far ahead or merged as late (abuse/latency telemetry). */
  dropped = 0

  /** Seq of the frame consumed most recently (echoed as `lastInputSeq`). */
  get lastSeq(): number {
    return (this.expect - 1) & 0xff_ff
  }

  /** The most recent frame consumed (its held state is what silence repeats). */
  get current(): WireFrame {
    return this.last
  }

  push(seq: number, frames: readonly WireFrame[]): void {
    const newest = (seq + frames.length - 1) & 0xff_ff
    if (this.expect < 0) {
      this.expect = (newest - INPUT_BUFFER_FRAMES + 1) & 0xff_ff
    }
    for (const [i, f] of frames.entries()) {
      this.add((seq + i) & 0xff_ff, f)
    }
    const ahead = seqDiff(newest, this.expect)
    if (ahead > MAX_AHEAD_FRAMES) {
      this.fastForward((newest - INPUT_BUFFER_FRAMES + 1) & 0xff_ff)
    }
  }

  private add(seq: number, f: WireFrame): void {
    if (seqDiff(seq, this.expect) < 0) {
      // Its number was already consumed as a repeat: apply its content next tick.
      this.late = f
      this.edges |= f.buttons & EDGE_BUTTONS
      this.dropped++
      return
    }
    this.pending.set(seq, f)
  }

  private fastForward(to: number): void {
    for (const [s, f] of this.pending) {
      if (seqDiff(s, to) < 0) {
        this.edges |= f.buttons & EDGE_BUTTONS
        this.late = f
        this.pending.delete(s)
        this.dropped++
      }
    }
    this.expect = to
  }

  /** The frame for this tick: the next numbered frame, a late one, or the last one again. */
  next(): { seq: number; frame: WireFrame } | null {
    if (this.expect < 0) {
      return null
    }
    const seq = this.expect
    let f = this.pending.get(seq)
    if (f) {
      this.pending.delete(seq)
    } else {
      f = this.late ?? this.last
    }
    this.late = null
    const frame = this.edges ? { ...f, buttons: f.buttons | this.edges } : f
    this.edges = 0
    this.last = f
    this.expect = (seq + 1) & 0xff_ff
    return { seq, frame }
  }
}
