import type { RankedResumed } from '../contract/ranked.ts'
import type { RankedSession, ServerMessage } from '../net/ranked.ts'
import type { ClockEvents, DuelClock, StandoffSpec } from './clock.ts'
import { callLead, PendingCall } from './pending-call.ts'

interface Queued {
  duel: number
  standoff: boolean
  send: () => void
}

/**
 * How long the server may take to send the call once it has a standoff. The
 * longest wait is the boss's clock: seven strikes at up to 1.6 s each.
 */
const CALL_DEADLINE_MS = 16_000
/** How long a verdict may take after the call (the outlaw's draw plus a round trip). */
const VERDICT_DEADLINE_MS = 4000

const noop = (): void => undefined

/**
 * Ranked: the server owns the wait, the cues, the call and the verdict. This
 * clock sends `standoff` and `shot`, and turns server messages into the same
 * events the practice clock raises. A new standoff waits until the server has
 * judged the previous duel (a stall loss resolves on the server's own timer).
 *
 * A dropped link is resumed when the server allows it: sends wait, the watchdog
 * rests, and on the way back any standoff in flight (voided by the server) is
 * forgotten so the director can run it again. Anything else unexpected (the
 * link not coming back, any server error, the server going quiet mid-standoff)
 * is reported once as `dropped`, and the director carries on in practice: the
 * player is never left waiting on a call that won't come.
 */
export class RankedDuelClock implements DuelClock {
  readonly ranked = true as boolean
  readonly session: RankedSession
  private readonly events: ClockEvents
  private duel = -1
  private unresolved = null as number | null
  private queue: Queued[] = []
  /** perf time by which the server must next answer; 0 when nothing is pending. */
  private deadline = 0
  /** Banking the run: errors belong to the leaderboard form, not to the duel. */
  private banking = false as boolean
  /** Banked, dropped or disposed: the socket closing now is expected. */
  private over = false as boolean
  private readonly levels = new Map<number, number>()
  private readonly paid = new Map<number, number>()
  /** The link is down and being resumed: nothing is sent, nothing times out. */
  private reconnecting = false as boolean
  /** The call, sent ahead of itself: presented on its own frame (and its bell scheduled for it). */
  private readonly pending = new PendingCall()

  constructor(session: RankedSession, events: ClockEvents) {
    this.session = session
    this.events = events
    session.listen({
      message: (m) => this.onMessage(m),
      closed: (reason) => this.drop(reason),
      reconnecting: () => this.onReconnecting(),
      resumed: (r) => this.onResumed(r),
    })
  }

  private onReconnecting(): void {
    if (this.over) {
      return
    }
    this.reconnecting = true
    this.deadline = 0
    this.pending.clear()
    this.events.reconnecting(true)
  }

  /**
   * Back on the run. The server voided any standoff in flight: forget it and anything queued for
   * it, so the director can stage it again. If the server expects a different outlaw than the
   * one in flight (a verdict was lost on the way), the run can't be reconciled and drops.
   */
  private onResumed(r: RankedResumed | null): void {
    if (this.over) {
      return
    }
    this.reconnecting = false
    const inFlight = this.unresolved === null ? null : (this.levels.get(this.unresolved) ?? null)
    if (r === null || (inFlight !== null && !r.complete && r.level !== inFlight)) {
      this.drop('The server lost this run.')
      return
    }
    if (this.unresolved !== null) {
      this.levels.delete(this.unresolved)
    }
    this.unresolved = null
    this.deadline = 0
    this.queue = []
    // duel numbers strictly increase: the next standoff takes at least `nextDuel`
    this.duel = Math.max(this.duel, r.nextDuel - 1)
    this.events.reconnecting(false)
    this.events.resumed(r.purse)
  }

  /** The server's payout for each outlaw beaten this run (for the ledger). */
  paidFor(level: number): number | null {
    return this.paid.get(level) ?? null
  }

  /** Bank the run under `name`. On success the session is over (the server closes it). */
  async bank(name: string): ReturnType<RankedSession['finish']> {
    this.banking = true
    const r = await this.session.finish(name)
    this.banking = false
    if (r.ok) {
      this.over = true
    } else if (!this.session.open) {
      this.drop(r.error)
    }
    return r
  }

  private drop(reason: string): void {
    if (this.over) {
      return
    }
    this.over = true
    this.queue = []
    this.deadline = 0
    this.pending.clear()
    this.events.dropped(reason)
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'cue':
        this.events.cue(m.duel, m.cue)
        break
      case 'call':
        if (m.duel === this.unresolved) {
          this.deadline = performance.now() + callLead(m.inMs) + VERDICT_DEADLINE_MS
        }
        if (!this.pending.arm(m.duel, m.inMs)) {
          this.events.call(m.duel)
        }
        break
      case 'result':
        this.onResult(m)
        break
      case 'error':
        // a bad name while banking is the form's to show; anything else means the server
        // and this client disagree about the run (e.g. "Out of order"), so it can't stay ranked
        if (!this.banking) {
          this.drop(m.message)
        }
        break
      default:
        break
    }
  }

  private onResult(m: Extract<ServerMessage, { type: 'result' }>): void {
    if (this.unresolved === m.duel) {
      this.unresolved = null
      this.deadline = 0
    }
    const level = this.levels.get(m.duel)
    this.levels.delete(m.duel)
    if (m.outcome === 'win' && level !== undefined) {
      this.paid.set(level, (this.paid.get(level) ?? 0) + m.payout)
    }
    this.events.verdict(m)
    this.flush()
  }

  private flush(): void {
    while (!(this.over || this.reconnecting) && this.queue.length > 0) {
      const q = this.queue[0]
      if (!q || (q.standoff && this.unresolved !== null)) {
        return
      }
      this.queue.shift()
      if (q.standoff) {
        this.unresolved = q.duel
        this.deadline = performance.now() + CALL_DEADLINE_MS
      }
      q.send()
    }
  }

  standoff(spec: StandoffSpec): number {
    this.duel++
    const duel = this.duel
    this.levels.set(duel, spec.level)
    this.queue.push({
      duel,
      standoff: true,
      send: () => this.session.standoff(duel, spec.level, spec.touch),
    })
    this.flush()
    return duel
  }

  /** The call's time once the server has sent it ahead (a moment before it), else null. */
  callAt(): number | null {
    return this.pending.time
  }

  /** Presents a call sent ahead on its frame, and checks that the server is still talking. */
  tick(now: number): void {
    const due = this.pending.due(now)
    if (due !== null) {
      this.events.call(due)
    }
    if (!this.reconnecting && this.deadline > 0 && now > this.deadline) {
      this.drop('The server stopped responding.')
    }
  }

  shot(target: number, localMs: number | null): void {
    const duel = this.duel
    this.queue.push({
      duel,
      standoff: false,
      send: () => this.session.shot(duel, target, localMs),
    })
    this.flush()
  }

  /** The server's clock can't be paused or voided: its verdict stands. */
  readonly cancel: DuelClock['cancel'] = noop

  dispose(): void {
    this.over = true
    this.pending.clear()
    this.queue = []
    this.deadline = 0
    this.session.close()
  }
}
