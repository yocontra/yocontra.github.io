import {
  RANKED_RESUME_WINDOW_MS,
  type RankedResumed,
  type RankedSessionResponse,
  rankedClosedCopy,
  resumeUrl,
} from '../contract/ranked.ts'
import { openReconnecting, type ReconnectingSocket } from '../platform/reconnect.ts'
import { getAccessToken } from './auth.ts'
import { LEADERBOARD_URL, type Result } from './leaderboard.ts'

/**
 * The ranked session: a WebSocket to the server's DuelSession. The server owns
 * the wait, the cues, the call, the outlaw's draw, the verdict and the purse;
 * this module only carries messages. Every failure becomes a polite string.
 *
 * A dropped socket (a network switch, the server restarting its object) is not the end of the
 * run: when the server handed out a resume token, the session reconnects with backoff and the
 * server answers with a `hello` carrying `resumed` (where the run stands). Without a token, or
 * once the token is refused, the run drops to practice as before.
 */

export type ServerMessage =
  | { type: 'hello'; sessionId: string; economyVersion: number; resumed?: RankedResumed }
  | { type: 'ping'; n: number }
  | { type: 'cue'; duel: number; cue: string }
  | { type: 'call'; duel: number; inMs?: number }
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
  /** The run is over for good (dropped and not resumable, or closed). */
  closed: (reason: string) => void
  /** The link dropped and a resume is under way. */
  reconnecting: (reason: string) => void
  /** Back on the same run; `resumed` is the server's account of where it stands. */
  resumed: (resumed: RankedResumed | null) => void
}

const CONNECT_TIMEOUT_MS = 8000
const FINAL_TIMEOUT_MS = 10_000
/** The server pings every 400 ms: this much silence is a dead link. */
const STALE_MS = 2500

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

const validResume = (v: unknown): boolean =>
  v === undefined || (isRecord(v) && num(v.level) && num(v.purse) && num(v.nextDuel))

const VALIDATORS: Record<string, (m: Record<string, unknown>) => boolean> = {
  hello: (m) => typeof m.sessionId === 'string' && validResume(m.resumed),
  ping: (m) => num(m.n),
  cue: (m) => num(m.duel) && typeof m.cue === 'string',
  call: (m) => num(m.duel) && (m.inMs === undefined || num(m.inMs)),
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

async function createSession(token: string): Promise<Result<RankedSessionResponse>> {
  try {
    // Signed in, the run belongs to your account: first clears pay XP and dollars and earn the
    // Bounty Hunt licence. Without the bearer the server can't tell, and the run stays anonymous.
    const headers = new Headers({ 'content-type': 'application/json' })
    const bearer = await getAccessToken().catch(() => null)
    if (bearer) {
      headers.set('Authorization', `Bearer ${bearer}`)
    }
    const res = await fetch(`${LEADERBOARD_URL}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ turnstileToken: token }),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = isRecord(body) && typeof body.error === 'string' ? body.error : null
      const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason : null
      if (reason === 'over_budget') {
        return { ok: false, error: msg ?? rankedClosedCopy() }
      }
      return {
        ok: false,
        error:
          res.status === 429
            ? 'Too many ranked starts. Wait a moment and try again.'
            : (msg ?? 'No ranked seat today.'),
      }
    }
    if (!isRecord(body) || typeof body.wsUrl !== 'string') {
      return { ok: false, error: 'The ranked server sent something odd back.' }
    }
    return {
      ok: true,
      value: {
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        wsUrl: body.wsUrl,
        // An empty token means this server can't resume: a drop ends the run.
        resumeToken: typeof body.resumeToken === 'string' ? body.resumeToken : '',
      },
    }
  } catch {
    return { ok: false, error: 'Couldn’t reach the ranked server.' }
  }
}

export class RankedSession {
  private readonly link: ReconnectingSocket
  private handlers: RankedHandlers | null = null
  private closedReason = null as string | null
  private finalWaiter = null as ((r: Result<{ total: number; rank: number }>) => void) | null
  /** Waiting for the first `hello` (the session isn't handed out until then). */
  private onFirstHello = null as ((ok: boolean) => void) | null
  /** A reconnect is in flight: the next `hello` is the resume. */
  private resuming = false as boolean
  private linkUp = false as boolean

  private constructor(created: RankedSessionResponse, firstHello: (ok: boolean) => void) {
    this.onFirstHello = firstHello
    this.link = openReconnecting({
      // the first attempt opens the run; later ones resume it, or give up without a token
      url: () => {
        if (!this.linkUp) {
          return Promise.resolve(created.wsUrl)
        }
        return Promise.resolve(
          created.resumeToken ? resumeUrl(created.wsUrl, created.resumeToken) : null,
        )
      },
      onOpen: () => {
        this.linkUp = true
      },
      onMessage: (data) => this.onMessage(data),
      onDrop: (reason) => this.onDrop(reason),
      onGiveUp: (reason) => this.onClose(this.linkUp ? 'The ranked connection dropped.' : reason),
      staleMs: STALE_MS,
      deadlineMs: RANKED_RESUME_WINDOW_MS,
      binaryType: 'blob',
      // a run that's over (banked, refused, fatal error) never comes back
      isFinal: (code) => code === 1000 || code === 1008 || (code >= 4000 && code < 4100),
    })
  }

  /** POST /sessions with a Turnstile token, then open the socket and wait for hello. */
  static async connect(token: string): Promise<Result<RankedSession>> {
    const created = await createSession(token)
    if (!created.ok) {
      return created
    }
    return await new Promise<Result<RankedSession>>((resolve) => {
      const timer = setTimeout(() => {
        session.close()
        resolve({ ok: false, error: 'The ranked server didn’t answer.' })
      }, CONNECT_TIMEOUT_MS)
      const session: RankedSession = new RankedSession(created.value, (ok) => {
        clearTimeout(timer)
        resolve(
          ok
            ? { ok: true, value: session }
            : { ok: false, error: 'Couldn’t open the ranked connection.' },
        )
      })
    })
  }

  get open(): boolean {
    return this.closedReason === null && this.link.state === 'open' && !this.resuming
  }

  listen(h: RankedHandlers): void {
    this.handlers = h
  }

  private send(m: Record<string, unknown>): void {
    if (this.open) {
      this.link.send(JSON.stringify(m))
    }
  }

  private onDrop(reason: string): void {
    if (this.closedReason !== null) {
      return
    }
    if (this.onFirstHello) {
      return
    }
    this.resuming = true
    // a run being banked can't be confirmed over a dead link: the form says so and can retry
    this.finalWaiter?.({ ok: false, error: 'The ranked connection dropped. Try again.' })
    this.finalWaiter = null
    this.handlers?.reconnecting(reason)
  }

  private onHello(m: Extract<ServerMessage, { type: 'hello' }>): void {
    if (this.onFirstHello) {
      const first = this.onFirstHello
      this.onFirstHello = null
      first(true)
      return
    }
    if (this.resuming) {
      this.resuming = false
      this.handlers?.resumed(m.resumed ?? null)
    }
  }

  private onMessage(data: unknown): void {
    const m = parseServerMessage(data)
    if (!m) {
      return
    }
    switch (m.type) {
      case 'ping':
        // answered synchronously: this is the latency probe
        this.link.send(JSON.stringify({ type: 'pong', n: m.n }))
        return
      case 'hello':
        this.onHello(m)
        return
      case 'final':
        this.finalWaiter?.({ ok: true, value: { total: m.total, rank: m.rank } })
        this.finalWaiter = null
        break
      case 'error':
        if (this.finalWaiter) {
          this.finalWaiter({ ok: false, error: m.message })
          this.finalWaiter = null
        }
        break
      default:
        break
    }
    this.handlers?.message(m)
  }

  private onClose(reason: string): void {
    if (this.closedReason !== null) {
      return
    }
    this.closedReason = reason
    this.resuming = false
    if (this.onFirstHello) {
      const first = this.onFirstHello
      this.onFirstHello = null
      first(false)
    }
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
    this.link.close()
  }
}
