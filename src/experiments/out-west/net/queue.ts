/**
 * The Bounty Hunt queue: a Turnstile token buys a ticket (`POST /queue/ticket`), the ticket opens
 * the queue socket, and the matchmaker answers with `status` once a second until it says
 * `matched` (or `refused`). Pings are answered at once: the matchmaker uses them to keep rough
 * connections out of human duels.
 */
import type { QueueClientMessage, QueueServerMessage } from '../contract/duel.ts'
import { queueTicket } from './api.ts'

export type QueueStatus = Extract<QueueServerMessage, { type: 'status' }>
export type QueueMatch = Extract<QueueServerMessage, { type: 'matched' }>

export interface QueueHandlers {
  queued: (m: Extract<QueueServerMessage, { type: 'queued' }>) => void
  status: (s: QueueStatus) => void
  matched: (m: QueueMatch) => void
  /** Refused, errored or dropped: the search is over. `reason` is the matchmaker's refusal code. */
  failed: (message: string, reason?: string) => void
}

const KNOWN = new Set(['queued', 'ping', 'status', 'matched', 'refused', 'error'])

export function parseQueueMessage(raw: unknown): QueueServerMessage | null {
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null && KNOWN.has(String(Reflect.get(v, 'type')))) {
      return v as QueueServerMessage
    }
  } catch {
    // not JSON
  }
  return null
}

const REFUSALS: Record<string, string> = {
  budget: 'Bounty Hunt is resting until the next UTC day.',
  unlicensed: 'You need a licence. Beat 3 outlaws on a ranked run.',
  cooldown: 'You dodged too many duels. Wait a while, then try again.',
  busy: 'You’re already in a queue or duel in another tab.',
  unauthorized: 'Your sign-in expired. Try again.',
  'no-profile': 'Sign in first.',
}

export class QueueSearch {
  private ws: WebSocket | null = null
  private done = false as boolean
  private readonly h: QueueHandlers

  constructor(h: QueueHandlers) {
    this.h = h
  }

  /** Spend a Turnstile token on a ticket, then join the queue. */
  async start(turnstileToken: string): Promise<void> {
    const t = await queueTicket(turnstileToken)
    if (this.done) {
      return
    }
    if (!t.ok) {
      this.fail(t.error)
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(t.value.wsUrl)
    } catch {
      this.fail('Couldn’t connect. Check your connection and try again.')
      return
    }
    this.ws = ws
    ws.addEventListener('message', (e) => this.onMessage(e.data))
    ws.addEventListener('close', () => this.fail('Connection lost. Try again.'))
  }

  private send(m: QueueClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m))
    }
  }

  private onMessage(data: unknown): void {
    const m = parseQueueMessage(data)
    if (!m || this.done) {
      return
    }
    switch (m.type) {
      case 'ping':
        this.send({ type: 'pong', n: m.n })
        break
      case 'queued':
        this.h.queued(m)
        break
      case 'status':
        this.h.status(m)
        break
      case 'matched':
        this.done = true
        this.ws?.close()
        this.h.matched(m)
        break
      case 'refused': {
        const wait = m.retryAfterS ? ` Try again in ${Math.ceil(m.retryAfterS / 60)} min.` : ''
        this.fail(`${REFUSALS[m.reason] ?? m.message}${wait}`, m.reason)
        break
      }
      default:
        this.fail(m.message)
        break
    }
  }

  /** "Duel a ghost now". */
  ghost(): void {
    this.send({ type: 'ghost' })
  }

  private fail(message: string, reason?: string): void {
    if (this.done) {
      return
    }
    this.done = true
    this.ws?.close()
    this.h.failed(message, reason)
  }

  /** Leave the queue quietly. */
  leave(): void {
    if (this.done) {
      return
    }
    this.done = true
    this.send({ type: 'leave' })
    this.ws?.close()
  }
}
