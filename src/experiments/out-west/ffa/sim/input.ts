/**
 * Send-on-change input, both ends. Pure, shared by the client (G) and the lobby.
 *
 * The client makes one frame per 20 Hz tick and numbers every one (`seq` + 1 each tick), but only
 * sends when something changed: at each 10 Hz slot it sends the slot's two frames if either
 * differs from the last frame it sent, and otherwise sends nothing, except a one-frame keepalive
 * every 500 ms. **Silence means "unchanged"**: the server applies the last frame again for every
 * frame number it hasn't been sent, so prediction stays exact (the client predicted the same
 * repeated frame).
 *
 * The server keeps a small jitter buffer: it consumes frame `expect` on each tick, starting two
 * frames behind the newest it has seen. A frame that arrives after its number was consumed is
 * applied on the next tick (and its button presses are kept); a client far ahead is fast-forwarded.
 * Either case shows up client-side as an ordinary reconciliation correction.
 */
import {
  BTN_CALLOUT,
  BTN_FIRE,
  BTN_INTERACT,
  BTN_LEAVE,
  BTN_RELOAD,
  BTN_ROLL,
} from '../../contract/town.ts'
import type { WireFrame } from './codec.ts'
import { TICK_HZ } from './constants.ts'

/** Aim is sent in steps of 1/1024 turn (0.35°: 13 cm of lateral error at 22 m). */
export const AIM_STEP = 64
export const KEEPALIVE_TICKS = TICK_HZ / 2
/** The server's jitter buffer, in frames behind the newest frame seen. */
export const INPUT_BUFFER_FRAMES = 2
/** A client this far ahead of the server is fast-forwarded. */
export const MAX_AHEAD_FRAMES = 8
/** Presses that must not be lost when frames are merged or dropped. */
const EDGE_BUTTONS = BTN_FIRE | BTN_ROLL | BTN_RELOAD | BTN_INTERACT | BTN_CALLOUT | BTN_LEAVE

export const quantizeAim = (aim: number): number =>
  (Math.round(aim / AIM_STEP) * AIM_STEP) & 0xff_ff

/** Stick, quantised aim and buttons: the parts that count as a change (view time doesn't). */
export const sameInput = (a: WireFrame, b: WireFrame): boolean =>
  a.moveX === b.moveX && a.moveZ === b.moveZ && a.aim === b.aim && a.buttons === b.buttons

const seqDiff = (a: number, b: number): number => ((a - b + 98_304) % 65_536) - 32_768

/** Client side: feed one frame per tick, get a message to send (or null). */
export class InputBatcher {
  private seq = 0
  private slot: WireFrame[] = []
  private lastSent: WireFrame | null = null
  private sinceSend = 0

  /** The seq the next `push` will be numbered with. */
  get nextSeq(): number {
    return this.seq
  }

  /**
   * Add this tick's frame (aim is quantised here). Returns the frames to send and the seq of the
   * first, or null for silence. Call every tick, even when nothing is pressed.
   */
  push(frame: WireFrame): { seq: number; frames: WireFrame[] } | null {
    const f = { ...frame, aim: quantizeAim(frame.aim) }
    const seq = this.seq
    this.seq = (this.seq + 1) & 0xff_ff
    this.slot.push(f)
    this.sinceSend++
    if (this.slot.length < 2) {
      return null
    }
    const frames = this.slot
    this.slot = []
    const firstSeq = (seq - 1) & 0xff_ff
    const last = this.lastSent
    const changed = !last || frames.some((x) => !sameInput(x, last))
    if (changed) {
      this.lastSent = frames.at(-1) ?? f
      this.sinceSend = 0
      return { seq: firstSeq, frames }
    }
    if (this.sinceSend >= KEEPALIVE_TICKS) {
      this.sinceSend = 0
      return { seq, frames: [f] }
    }
    return null
  }
}

/** Server side: one per player. */
export class InputQueue {
  private readonly pending = new Map<number, WireFrame>()
  private expect = -1
  private last: WireFrame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }
  private late: WireFrame | null = null
  private edges = 0
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
