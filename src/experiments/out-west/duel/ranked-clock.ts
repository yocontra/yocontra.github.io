// biome-ignore-all lint/style/useThisInClassMethods: interface methods that are deliberate no-ops for this implementation
import type { RankedSession, ServerMessage } from '../net/ranked.ts'
import type { ClockEvents, DuelClock, StandoffSpec } from './clock.ts'

interface Queued {
  duel: number
  standoff: boolean
  send: () => void
}

/**
 * Ranked: the server owns the wait, the cues, the call and the verdict. This
 * clock sends `standoff` and `shot`, and turns server messages into the same
 * events the practice clock raises. A new standoff waits until the server has
 * judged the previous duel (a stall loss resolves on the server's own timer).
 */
export class RankedDuelClock implements DuelClock {
  readonly ranked = true as boolean
  readonly session: RankedSession
  private readonly events: ClockEvents
  private duel = -1
  private unresolved = null as number | null
  private queue: Queued[] = []
  private finished = false as boolean

  constructor(session: RankedSession, events: ClockEvents) {
    this.session = session
    this.events = events
    session.listen({
      message: (m) => this.onMessage(m),
      closed: (reason) => {
        if (!this.finished) {
          events.dropped(reason)
        }
      },
    })
  }

  /** The run was banked: the socket closing now is expected. */
  markFinished(): void {
    this.finished = true
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'cue':
        this.events.cue(m.duel, m.cue)
        break
      case 'call':
        this.events.call(m.duel)
        break
      case 'result':
        if (this.unresolved === m.duel) {
          this.unresolved = null
        }
        this.events.verdict(m)
        this.flush()
        break
      case 'error':
        if (m.fatal) {
          this.events.dropped(m.message)
        }
        break
      default:
        break
    }
  }

  private flush(): void {
    while (this.queue.length > 0) {
      const q = this.queue[0]
      if (!q || (q.standoff && this.unresolved !== null)) {
        return
      }
      this.queue.shift()
      if (q.standoff) {
        this.unresolved = q.duel
      }
      q.send()
    }
  }

  standoff(spec: StandoffSpec): number {
    this.duel++
    const duel = this.duel
    this.queue.push({
      duel,
      standoff: true,
      send: () => this.session.standoff(duel, spec.level),
    })
    this.flush()
    return duel
  }

  callAt(): number | null {
    return null
  }

  tick(): void {
    // driven by server messages
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

  cancel(): void {
    // the server's clock can't be paused
  }

  dispose(): void {
    this.finished = true
    this.queue = []
  }
}
