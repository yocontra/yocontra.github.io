import type { DuelRoomLink } from '../net/pvp.ts'
import type { DuelClock } from './clock.ts'

/**
 * Bounty Hunt's clock: the DuelRoom owns the walk, the wait, the fake-out cues, the call and the
 * judging, so this clock only carries your shot (with `localMs`, measured from the moment the call
 * arrived) and tells the director the server is in charge. The controller in `pvp-duel.ts` feeds
 * the room's cues and call into the director's usual clock events.
 */

const noop = (): void => undefined
const unknownCall = (): null => null

export class RemoteDuelClock implements DuelClock {
  readonly ranked = true as boolean
  /** The room's draw number (a new one after each dead heat and each rematch). */
  draw = 0
  private readonly link: DuelRoomLink

  constructor(link: DuelRoomLink) {
    this.link = link
  }

  /** The room starts every standoff itself; the attempt id is its draw number. */
  standoff(): number {
    return this.draw
  }

  /** The room never says when the call is coming. */
  readonly callAt: DuelClock['callAt'] = unknownCall

  /** Room messages drive the duel; the link's stale-socket check covers a quiet server. */
  readonly tick: DuelClock['tick'] = noop

  shot(_target: number, localMs: number | null): void {
    this.link.send({ type: 'shot', draw: this.draw, localMs })
  }

  /** The room's clock can't be paused or voided. */
  readonly cancel: DuelClock['cancel'] = noop

  /** The controller owns the link. */
  readonly dispose: DuelClock['dispose'] = noop
}
