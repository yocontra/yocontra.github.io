import { LEADERBOARD_URL, type Result } from './leaderboard.ts'

/**
 * The ranked session: a WebSocket to the server's DuelSession. The server owns
 * the wait, the cues, the call, the outlaw's draw, the verdict and the purse;
 * this module only carries messages. Every failure becomes a polite string.
 */

export type ServerMessage =
  | { type: 'hello'; sessionId: string; economyVersion: number }
  | { type: 'ping'; n: number }
  | { type: 'cue'; duel: number; cue: string }
  | { type: 'call'; duel: number }
  | {
      type: 'result'
      duel: number
      outcome: 'win' | 'loss' | 'coward'
      reactionMs: number | null
      enemyMs: number | null
      payout: number
      purse: number
      targetsHit: number
    }
  | { type: 'final'; total: number; rank: number }
  | { type: 'error'; message: string; fatal: boolean }

export interface RankedHandlers {
  message: (m: ServerMessage) => void
  closed: (reason: string) => void
}

const CONNECT_TIMEOUT_MS = 8000
const FINAL_TIMEOUT_MS = 10_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): v is number | null => v === null || num(v)

const OUTCOMES = new Set(['win', 'loss', 'coward'])

function validResult(m: Record<string, unknown>): boolean {
  return (
    num(m.duel) &&
    typeof m.outcome === 'string' &&
    OUTCOMES.has(m.outcome) &&
    numOrNull(m.reactionMs) &&
    numOrNull(m.enemyMs) &&
    num(m.payout) &&
    num(m.purse) &&
    num(m.targetsHit)
  )
}

const VALIDATORS: Record<string, (m: Record<string, unknown>) => boolean> = {
  hello: (m) => typeof m.sessionId === 'string',
  ping: (m) => num(m.n),
  cue: (m) => num(m.duel) && typeof m.cue === 'string',
  call: (m) => num(m.duel),
  result: validResult,
  final: (m) => num(m.total) && num(m.rank),
  error: (m) => typeof m.message === 'string',
}

/** Parse and shape-check one server message; null when it isn't one we know. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') {
    return null
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(v) || typeof v.type !== 'string') {
    return null
  }
  const check = VALIDATORS[v.type]
  return check?.(v) ? (v as ServerMessage) : null
}

async function createSession(token: string): Promise<Result<string>> {
  try {
    const res = await fetch(`${LEADERBOARD_URL}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: token }),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = isRecord(body) && typeof body.error === 'string' ? body.error : null
      return {
        ok: false,
        error:
          res.status === 429
            ? 'Easy, partner. Try ranked again in a bit.'
            : (msg ?? 'No ranked seat today.'),
      }
    }
    if (!isRecord(body) || typeof body.wsUrl !== 'string') {
      return { ok: false, error: 'The ranked server sent something odd back.' }
    }
    return { ok: true, value: body.wsUrl }
  } catch {
    return { ok: false, error: 'Couldn’t reach the ranked server.' }
  }
}

export class RankedSession {
  private readonly ws: WebSocket
  private handlers: RankedHandlers | null = null
  private closedReason = null as string | null
  private finalWaiter = null as ((r: Result<{ total: number; rank: number }>) => void) | null

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (e) => this.onMessage(e.data))
    ws.addEventListener('close', () => this.onClose('The ranked connection closed.'))
    ws.addEventListener('error', () => this.onClose('The ranked connection dropped.'))
  }

  /** POST /sessions with a Turnstile token, then open the socket and wait for hello. */
  static async connect(token: string): Promise<Result<RankedSession>> {
    const created = await createSession(token)
    if (!created.ok) {
      return created
    }
    return await new Promise<Result<RankedSession>>((resolve) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(created.value)
      } catch {
        resolve({ ok: false, error: 'Couldn’t open the ranked connection.' })
        return
      }
      const timer = setTimeout(() => {
        ws.close()
        resolve({ ok: false, error: 'The ranked server didn’t answer.' })
      }, CONNECT_TIMEOUT_MS)
      const onFirst = (e: MessageEvent): void => {
        const m = parseServerMessage(e.data)
        if (m?.type !== 'hello') {
          return
        }
        clearTimeout(timer)
        ws.removeEventListener('message', onFirst)
        resolve({ ok: true, value: new RankedSession(ws) })
      }
      ws.addEventListener('message', onFirst)
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        resolve({ ok: false, error: 'Couldn’t open the ranked connection.' })
      })
    })
  }

  get open(): boolean {
    return this.closedReason === null && this.ws.readyState === WebSocket.OPEN
  }

  listen(h: RankedHandlers): void {
    this.handlers = h
  }

  private send(m: Record<string, unknown>): void {
    if (this.open) {
      this.ws.send(JSON.stringify(m))
    }
  }

  private onMessage(data: unknown): void {
    const m = parseServerMessage(data)
    if (!m) {
      return
    }
    if (m.type === 'ping') {
      // answered synchronously: this is the latency probe
      this.send({ type: 'pong', n: m.n })
      return
    }
    if (m.type === 'final') {
      this.finalWaiter?.({ ok: true, value: { total: m.total, rank: m.rank } })
      this.finalWaiter = null
    }
    if (m.type === 'error' && this.finalWaiter) {
      this.finalWaiter({ ok: false, error: m.message })
      this.finalWaiter = null
    }
    this.handlers?.message(m)
  }

  private onClose(reason: string): void {
    if (this.closedReason !== null) {
      return
    }
    this.closedReason = reason
    this.finalWaiter?.({ ok: false, error: reason })
    this.finalWaiter = null
    this.handlers?.closed(reason)
  }

  standoff(duel: number, level: number): void {
    this.send({ type: 'standoff', duel, level })
  }

  shot(duel: number, target: number, localMs: number | null): void {
    this.send({ type: 'shot', duel, target, localMs })
  }

  /** Bank the run under `name`; resolves with the server's total and rank. */
  async finish(name: string): Promise<Result<{ total: number; rank: number }>> {
    if (!this.open) {
      return { ok: false, error: 'The ranked connection is closed.' }
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finalWaiter = null
        resolve({ ok: false, error: 'The ranked server didn’t confirm the run.' })
      }, FINAL_TIMEOUT_MS)
      this.finalWaiter = (r) => {
        clearTimeout(timer)
        resolve(r)
      }
      this.send({ type: 'finish', name })
    })
  }

  close(): void {
    this.onClose('closed')
    this.ws.close()
  }
}
