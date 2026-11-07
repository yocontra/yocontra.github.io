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
import { BTN_CALLOUT, BTN_FIRE, BTN_LEAVE, BTN_RELOAD, BTN_ROLL } from '../../contract/town.ts'
import type { WireFrame } from './codec.ts'
import { TICK_HZ } from './constants.ts'

/** Aim is sent in steps of 1/1024 turn (0.35°: 13 cm of lateral error at 22 m). */
export const AIM_STEP = 64
export const KEEPALIVE_TICKS = TICK_HZ / 2
/** The server's jitter buffer, in frames behind the newest frame seen. */
export const INPUT_BUFFER_FRAMES = 2
/** A client this far ahead of the server is fast-forwarded. */
export const MAX_AHEAD_FRAMES = 10
/** Presses that must not be lost when frames are merged or dropped. */
export const EDGE_BUTTONS = BTN_FIRE | BTN_ROLL | BTN_RELOAD | BTN_CALLOUT | BTN_LEAVE

export const quantizeAim = (aim: number): number =>
  (Math.round(aim / AIM_STEP) * AIM_STEP) & 0xff_ff

/** Stick, quantised aim and buttons: the parts that count as a change (view time doesn't). */
export const sameInput = (a: WireFrame, b: WireFrame): boolean =>
  a.moveX === b.moveX &&
  a.moveZ === b.moveZ &&
  a.aim === b.aim &&
  a.buttons === b.buttons &&
  (a.pitch ?? 0) === (b.pitch ?? 0)

/** Keep every signed wire unit: larger pitch steps can send an aimed shot above a distant rider. */
export const quantizePitch = (p: number): number => Math.max(-127, Math.min(127, Math.round(p)))

export const seqDiff = (a: number, b: number): number => ((a - b + 98_304) % 65_536) - 32_768

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
   * Jump the frame numbers `n` ahead (the server already repeated those frames: see
   * `client/tick-clock.ts`). A half-filled slot goes out now, alone, so no frame is lost, and the
   * next slot is sent whatever it holds, to re-anchor the server's queue.
   */
  skip(n: number): { seq: number; frames: WireFrame[] } | null {
    const held = this.slot
    this.slot = []
    this.lastSent = null
    const out = held.length > 0 ? { seq: (this.seq - held.length) & 0xff_ff, frames: held } : null
    this.seq = (this.seq + n) & 0xff_ff
    return out
  }

  /**
   * Add this tick's frame (aim is quantised here). Returns the frames to send and the seq of the
   * first, or null for silence. Call every tick, even when nothing is pressed.
   */
  push(frame: WireFrame): { seq: number; frames: WireFrame[] } | null {
    const f = { ...frame, aim: quantizeAim(frame.aim), pitch: quantizePitch(frame.pitch ?? 0) }
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
