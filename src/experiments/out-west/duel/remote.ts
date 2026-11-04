import type { DuelRoomLink } from '../net/pvp.ts'
import type { DuelClock } from './clock.ts'
import { PendingCall } from './pending-call.ts'

/**
 * Bounty Hunt's clock: the DuelRoom owns the walk, the wait, the fake-out cues, the call and the
 * judging, so this clock carries your shot (with `localMs`, measured from the moment the call was
 * presented), holds a call the room sent ahead until its frame, and tells the director the server is
 * in charge. The controller in `pvp-duel.ts` feeds the room's cues and call into the director's usual
 * clock events.
 */

const noop = (): void => undefined

export class RemoteDuelClock implements DuelClock {
  readonly ranked = true as boolean
  /** The room's draw number (a new one after each dead heat and each rematch). */
  draw = 0
  private readonly link: DuelRoomLink
  private readonly pending = new PendingCall()
  private fire = noop as (draw: number) => void

  constructor(link: DuelRoomLink) {
    this.link = link
  }

  /** The room starts every standoff itself; the attempt id is its draw number. */
  standoff(): number {
    return this.draw
  }

  /**
   * The room's call: held until `inMs` from now (so the bell can be scheduled for that frame), or
   * presented at once when it came bare.
   */
  call(draw: number, inMs: unknown, fire: (draw: number) => void): void {
    this.fire = fire
    if (!this.pending.arm(draw, inMs)) {
      fire(draw)
    }
  }

  /** The held call's time (a moment before it), else null. */
  callAt(): number | null {
    return this.pending.time
  }

  /** Presents a held call on its frame; the link's stale-socket check covers a quiet server. */
  tick(now: number): void {
    const due = this.pending.due(now)
    if (due !== null) {
      this.fire(due)
    }
  }

  shot(_target: number, localMs: number | null): void {
    this.link.send({ type: 'shot', draw: this.draw, localMs })
  }

  /** The room's clock can't be paused or voided. */
  readonly cancel: DuelClock['cancel'] = noop

  /** The controller owns the link. */
  dispose(): void {
    this.pending.clear()
  }
}
