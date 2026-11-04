/**
 * DailySession: one Durable Object per Daily Outlaw attempt (meta-game stream). It speaks the
 * ranked protocol (`contract/ranked.ts`) for exactly one duel, so the client drives it with its
 * ranked clock: hello, pings, `standoff`, the server's cues and call, `shot`, `result`.
 *
 * The server owns the clock, as in a ranked run: the wait and the fake-outs are drawn here per
 * attempt and never sent early; the outlaw's draw comes from the day's public spec
 * (`data/daily.ts`). Budget (§14): no storage and no alarms; the object lives only while its one
 * socket is open (at most 90 s) and bills its seconds as `duel_seconds`.
 *
 * A dropped socket voids the attempt: it stays used, never judged, never paid.
 */
import { DurableObject } from 'cloudflare:workers'
import type { DailyResultExtra } from '../../../src/experiments/out-west/contract/meta.ts'
import type { RankedServerMessage } from '../../../src/experiments/out-west/contract/ranked.ts'
import { DAILY_PAY, type DailySpec, dailySpec } from '../../../src/experiments/out-west/data/daily.ts'
import { ECONOMY_VERSION } from '../../../src/experiments/out-west/data/economy.ts'
import { recordUsage } from '../budget.ts'
import { outlawOpponent } from '../duel/opponents.ts'
import { CALL_LEAD_MS, pvpWaitPlan, Standoff, type Verdict } from '../duel/standoff.ts'
import { ledgerStatements } from '../economy/ledger.ts'
import { dailyRewardStatements } from '../economy/medals.ts'
import type { Env } from '../env.ts'
import { rttStats } from '../judge.ts'
import type { DuelTuning } from '../tuning.ts'
import { dailyRank } from './board.ts'

const PING_INTERVAL_MS = 400
const RTT_SAMPLES = 12
/** The whole attempt (walk, wait, duel) must finish inside this. */
const LIFETIME_MS = 90_000

type ClientMessage =
  | { type: 'standoff'; duel: number; level: number }
  | { type: 'shot'; duel: number; target: number; localMs: number | null }
  | { type: 'pong'; n: number }
  | { type: 'finish'; name: string }

/** The server tuning for a day: one target, the spec's draw and the spec's fake-out count. */
export function dailyTuning(spec: DailySpec): DuelTuning {
  return {
    waitMs: spec.waitMs,
    fakeChance: spec.fakes > 0 ? 1 : 0,
    cues: spec.cues,
    targets: [{ drawMs: spec.drawMs, jitterMs: spec.jitterMs, accuracy: spec.accuracy }],
  }
}

export class DailySession extends DurableObject<Env> {
  private socket: WebSocket | null = null
  private openedAt = 0
  private id = ''
  private day = ''
  private accountId: string | null = null
  private standoff: Standoff | null = null
  private duel = -1
  private decided = false
  private pingSeq = 0
  private readonly pingSentAt = new Map<number, number>()
  private rttSamples: number[] = []
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private lifeTimer: ReturnType<typeof setTimeout> | undefined

  override fetch(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    if (this.openedAt > 0 || this.decided) {
      // one socket per attempt, ever: a reconnect would be a free retry
      return new Response('This ticket is used.', { status: 410 })
    }
    this.id = request.headers.get('X-Daily-Id') ?? ''
    this.day = request.headers.get('X-Day') ?? ''
    this.accountId = request.headers.get('X-Account-Id') || null
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.socket = server
    this.openedAt = Date.now()
    server.addEventListener('message', (event) => this.onMessage(event.data))
    server.addEventListener('close', () => this.onDrop())
    server.addEventListener('error', () => this.onDrop())
    this.send({ type: 'hello', sessionId: this.id, economyVersion: ECONOMY_VERSION })
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
    this.lifeTimer = setTimeout(() => this.close(1000, 'Time is up.'), LIFETIME_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  private send(message: RankedServerMessage | Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message))
    } catch {
      this.onDrop()
    }
  }

  private ping(): void {
    const n = ++this.pingSeq
    this.pingSentAt.set(n, Date.now())
    if (this.pingSentAt.size > RTT_SAMPLES * 2) {
      const oldest = this.pingSentAt.keys().next().value
      if (oldest !== undefined) {
        this.pingSentAt.delete(oldest)
      }
    }
    this.send({ type: 'ping', n })
  }

  private onMessage(data: string | ArrayBuffer): void {
    let m: ClientMessage | null = null
    try {
      m = typeof data === 'string' ? (JSON.parse(data) as ClientMessage) : null
    } catch {
      m = null
    }
    if (!m || typeof m !== 'object') {
      return
    }
    if (m.type === 'pong') {
      const sentAt = this.pingSentAt.get(m.n)
      if (sentAt !== undefined) {
        this.pingSentAt.delete(m.n)
        this.rttSamples.push(Date.now() - sentAt)
        if (this.rttSamples.length > RTT_SAMPLES) {
          this.rttSamples.shift()
        }
      }
      return
    }
    if (m.type === 'standoff') {
      this.onStandoff(m.duel)
    } else if (m.type === 'shot' && m.duel === this.duel) {
      this.standoff?.shot(0, typeof m.localMs === 'number' ? m.localMs : null, 0)
    }
  }

  private onStandoff(duel: number): void {
    if (this.standoff || this.decided) {
      this.send({ type: 'error', message: 'One duel per ticket.', fatal: false })
      return
    }
    if (!Number.isInteger(duel) || duel < 0) {
      this.send({ type: 'error', message: 'Bad duel number.', fatal: false })
      return
    }
    this.duel = duel
    const spec = dailySpec(this.day)
    const tuning = dailyTuning(spec)
    const standoff = new Standoff({
      mode: 'ranked',
      seats: [
        { kind: 'human', link: () => ({ ...rttStats(this.rttSamples), tcp: null }) },
        outlawOpponent(tuning),
      ],
      plan: pvpWaitPlan(spec.cues, Math.random, spec.waitMs, spec.fakes),
      leadMs: CALL_LEAD_MS,
      events: {
        cue: (cue) => this.send({ type: 'cue', duel, cue }),
        call: (_seat, inMs) => this.send({ type: 'call', duel, inMs }),
        end: (verdict) => {
          this.resolve(verdict).catch((err: unknown) => {
            console.error('daily result could not be recorded', err)
            this.close(1011, 'Could not record the duel.')
          })
        },
      },
    })
    this.standoff = standoff
    standoff.start()
  }

  private async resolve(verdict: Verdict): Promise<void> {
    if (this.decided || verdict.kind !== 'ranked') {
      return
    }
    this.decided = true
    const { outcome, reactionMs } = verdict
    const ms = outcome === 'win' && reactionMs !== null ? Math.max(1, Math.round(reactionMs)) : null
    const now = Date.now()
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE daily_runs SET outcome = ?2, reaction_ms = ?3, settled_at = ?4
         WHERE id = ?1 AND outcome IS NULL`,
      ).bind(this.id, outcome, ms, now),
    ]
    let paid = false
    const account = this.accountId
    if (account && outcome === 'win') {
      const before = await this.env.DB.prepare('SELECT 1 AS yes FROM ledger WHERE idem_key = ?')
        .bind(`daily:${account}:${this.day}#0`)
        .first<{ yes: number }>()
      paid = !before
      statements.push(
        ...ledgerStatements(this.env, `daily:${account}:${this.day}`, [
          {
            accountId: account,
            kind: 'daily_outlaw',
            amount: DAILY_PAY.cash,
            xp: DAILY_PAY.xp,
            ref: this.day,
          },
        ]),
      )
    }
    await this.env.DB.batch(statements)
    if (account && outcome === 'win') {
      // the Black Bandana counts days with a win, including the one just written
      const rewards = await dailyRewardStatements(this.env, account)
      if (rewards.length > 0) {
        await this.env.DB.batch(rewards)
      }
    }
    const rank = ms !== null && account ? await dailyRank(this.env, this.day, account) : null
    const extra: DailyResultExtra = { rank, xp: paid ? DAILY_PAY.xp : 0 }
    this.send({
      type: 'result',
      duel: this.duel,
      outcome,
      reactionMs,
      enemyMs: verdict.enemyMs,
      payout: paid ? DAILY_PAY.cash : 0,
      purse: paid ? DAILY_PAY.cash : 0,
      targetsHit: verdict.targetsHit,
      ...extra,
    })
    // let the result reach the client before the line closes
    setTimeout(() => this.close(1000, 'Duel recorded'), 1500)
  }

  private close(code: number, reason: string): void {
    const s = this.socket
    try {
      s?.close(code, reason)
    } catch {
      // already gone
    }
    this.onDrop()
  }

  /** The socket is gone: an undecided attempt is void (still used). Bill the time. */
  private onDrop(): void {
    if (!this.socket) {
      return
    }
    this.socket = null
    clearInterval(this.pingTimer)
    clearTimeout(this.lifeTimer)
    this.standoff?.abort()
    const seconds = (Date.now() - this.openedAt) / 1000
    this.ctx.waitUntil(recordUsage(this.env, 'duel_seconds', seconds).catch(() => undefined))
    if (!this.decided) {
      this.decided = true
      this.ctx.waitUntil(
        this.env.DB.prepare(
          "UPDATE daily_runs SET outcome = 'void', settled_at = ? WHERE id = ? AND outcome IS NULL",
        )
          .bind(Date.now(), this.id)
          .run()
          .catch(() => undefined),
      )
    }
  }
}
