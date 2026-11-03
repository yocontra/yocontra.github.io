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

export class DuelRoomLink {
  private readonly sock: ReconnectingSocket
  private readonly h: RoomHandlers
  private closed = false as boolean
  /** perf time the last message arrived (the call's arrival time is what `localMs` counts from). */
  lastAt = 0

  constructor(wsUrl: string, h: RoomHandlers) {
    this.h = h
    this.sock = openReconnecting({
      url: () => Promise.resolve(this.closed ? null : wsUrl),
      onOpen: (attempt) => {
        if (attempt > 0) {
          h.rejoined()
        }
      },
      onMessage: (data) => this.onMessage(data),
      onDrop: (reason) => h.dropped(reason),
      onGiveUp: (reason) => this.end(reason),
      // the server's pings run every 400 ms: 1.5 s of silence is a dead link
      staleMs: 1500,
      deadlineMs: 12_000,
    })
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
    this.h.message(m)
    if (m.type === 'closed') {
      this.end(m.reason === 'opponent-left' ? 'He lit out of town.' : 'The room closed.')
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
