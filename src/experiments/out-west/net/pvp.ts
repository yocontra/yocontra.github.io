/**
 * The Bounty Hunt duel room socket. The server owns every beat: this module only carries messages,
 * answers pings at once (the latency probe), and reconnects through drops by reopening the same
 * `wsUrl` (its room token is reusable for the life of the match). Grace is 5 s before the call and
 * none after, which the server enforces.
 */
import type { RoomClientMessage, RoomServerMessage } from '../contract/duel.ts'
import { openReconnecting, type ReconnectingSocket } from '../platform/reconnect.ts'

export interface RoomHandlers {
  message: (m: RoomServerMessage) => void
  /** Our own link dropped; a reconnect is under way. */
  dropped: (reason: string) => void
  /** Back after a drop (the server follows with `sync`). */
  rejoined: () => void
  /** Gave up reconnecting, or the room closed. */
  gone: (reason: string) => void
}

const KNOWN = new Set([
  'hello',
  'sync',
  'ping',
  'beat',
  'ready',
  'holding',
  'pace',
  'heckle',
  'cue',
  'call',
  'deadHeat',
  'suddenDeath',
  'result',
  'presence',
  'taunt',
  'rematch',
  'error',
  'closed',
])

export function parseRoomMessage(raw: unknown): RoomServerMessage | null {
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null && KNOWN.has(String(Reflect.get(v, 'type')))) {
      return v as RoomServerMessage
    }
  } catch {
    // not JSON
  }
  return null
}

const LIVE_STALE_MS = 1500

const CLOSED_TEXT: Record<string, string> = {
  'opponent-left': 'He left the duel.',
  timeout: 'No one pressed Ready in time. No penalty.',
  done: 'No more rematches with this player.',
  error: 'Server error. Try again.',
}

export class DuelRoomLink {
  private sock: ReconnectingSocket
  private readonly wsUrl: string
  /** Closed on purpose while the page is in the background; `resume()` reopens it. */
  private suspended = false as boolean
  private readonly h: RoomHandlers
  private closed = false as boolean
  /** perf time the last message arrived (the call's arrival time is what `localMs` counts from). */
  lastAt = 0
  /**
   * The room stops pinging in the rematch window so it can hibernate. Silence then is expected,
   * not a dead link: reconnecting would close both sockets and the room with them.
   */
  private quiet = false as boolean

  constructor(wsUrl: string, h: RoomHandlers) {
    this.h = h
    this.wsUrl = wsUrl
    this.sock = this.connect(false)
  }

  private connect(rejoin: boolean): ReconnectingSocket {
    const h = this.h
    return openReconnecting({
      url: () => Promise.resolve(this.closed ? null : this.wsUrl),
      onOpen: (attempt) => {
        if (attempt > 0 || rejoin) {
          h.rejoined()
        }
      },
      onMessage: (data) => this.onMessage(data),
      onDrop: (reason) => h.dropped(reason),
      onGiveUp: (reason) => this.end(reason),
      // the server's pings run every 400 ms: 1.5 s of silence is a dead link (except when quiet)
      staleMs: () => (this.quiet ? Number.POSITIVE_INFINITY : LIVE_STALE_MS),
      deadlineMs: 12_000,
    })
  }

  /**
   * The page went to the background: close the socket cleanly now, so the room's rules apply at
   * once (5 s of grace before the call, none after) instead of whenever the OS kills the socket.
   */
  suspend(): void {
    if (this.closed || this.suspended) {
      return
    }
    this.suspended = true
    this.sock.close(1000, 'backgrounded')
  }

  /** Back in the foreground: reopen the same room URL; the room answers with hello and sync. */
  resume(): void {
    if (this.closed || !this.suspended) {
      return
    }
    this.suspended = false
    this.sock = this.connect(true)
  }

  private onMessage(data: string | ArrayBuffer): void {
    this.lastAt = performance.now()
    const m = parseRoomMessage(data)
    if (!m) {
      return
    }
    if (m.type === 'ping') {
      // answered synchronously: this is the latency probe
      this.send({ type: 'pong', n: m.n })
      return
    }
    if (m.type === 'beat') {
      this.quiet = m.beat === 'result' || m.beat === 'rematch' || m.beat === 'closed'
    } else if (m.type === 'hello') {
      this.quiet = false
    } else if (m.type === 'sync') {
      this.quiet = m.beat === 'result' || m.beat === 'rematch'
    }
    this.h.message(m)
    if (m.type === 'closed') {
      this.end(CLOSED_TEXT[m.reason] ?? 'No more rematches at this table.')
    }
  }

  get open(): boolean {
    return this.sock.state === 'open'
  }

  send(m: RoomClientMessage): boolean {
    return this.sock.send(JSON.stringify(m))
  }

  private end(reason: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.sock.close()
    this.h.gone(reason)
  }

  close(): void {
    this.closed = true
    this.sock.close()
  }
}
