/**
 * DuelSession: one Durable Object per ranked run. The server owns the clock: it picks the wait,
 * plays the fake-outs, sends the call, samples the outlaw's draw, judges every shot with latency
 * compensation, and keeps the purse. The client only renders what it is told.
 *
 * The duel itself runs on the shared standoff engine (`duel/standoff.ts`) with an outlaw opponent.
 * A run may belong to a signed-in account (optional): its wins then pay gauntlet XP and dollars
 * through stream C, its duels against outlaw 6 and up seed the player's ghost, and the leaderboard
 * entry uses the account name.
 */
import { DurableObject } from 'cloudflare:workers'
import {
  type DuelRecord,
  ECONOMY_VERSION,
  payout,
  scoreRun,
} from '../../src/experiments/out-west/data/economy.ts'
import { recordUsage } from './budget.ts'
import { type CreditJob, CreditOutbox } from './duel/credit-outbox.ts'
import { gauntletClearStatements, getProfile, isNameOwned } from './duel/external.ts'
import {
  drawRating,
  GHOST_RING,
  type GhostSnapshot,
  ghostRecordStatements,
  RANKED_GHOST_MIN_LEVEL,
} from './duel/ghost.ts'
import { outlawOpponent } from './duel/opponents.ts'
import { rankedWaitPlan, Standoff, type Verdict, type WaitStats } from './duel/standoff.ts'
import type { Env } from './env.ts'
import { looksAutomated, rttStats } from './judge.ts'
import { type NameResult, validateName } from './names.ts'
import { BOSS_LEVEL, LAST_LEVEL, tuningFor } from './tuning.ts'

/** Kept for older imports; the session sees the whole Worker environment. */
export type SessionEnv = Env

type Phase = 1 | 2

const PING_INTERVAL_MS = 400
const RTT_SAMPLES = 12
const IDLE_TIMEOUT_MS = 15 * 60 * 1000

interface ActiveDuel {
  duel: number
  level: number
  phase: Phase
  standoff: Standoff
  done: boolean
}

type ClientMessage =
  | { type: 'standoff'; duel: number; level: number }
  | { type: 'shot'; duel: number; target: number; localMs: number | null }
  | { type: 'pong'; n: number }
  | { type: 'finish'; name: string }

function parseMessage(raw: string): ClientMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null
  }
  return value as ClientMessage
}

export class DuelSession extends DurableObject<Env> {
  private socket: WebSocket | null = null
  private sessionId = ''
  private clientHash = ''
  private accountId: string | null = null
  private accountName: string | null = null
  private used = false
  private finished = false
  private openedAt = 0

  private expectedLevel = 0
  private expectedPhase: Phase = 1
  private complete = false
  private readonly records: DuelRecord[] = []
  private readonly winReactions: number[] = []
  private active: ActiveDuel | null = null

  private pingSeq = 0
  private readonly pingSentAt = new Map<number, number>()
  private readonly rttSamples: number[] = []
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  /** The signed-in player's recent reactions and poster, loaded on first need. */
  private ghost: { snapshot: GhostSnapshot; recent: number[] } | null = null

  /** Account credits owed by judged duels, durable until their D1 batch commits. */
  private readonly outbox = new CreditOutbox({
    storage: this.ctx.storage,
    apply: (job) => this.applyCredit(job),
  })

  /** Retries credits that failed, including after the object was reset mid-write. */
  override async alarm(): Promise<void> {
    await this.outbox.drain()
  }

  override fetch(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by other handlers; Biome only sees the initial value
    if (this.used) {
      return new Response('Session already used', { status: 409 })
    }
    this.used = true
    this.sessionId = request.headers.get('X-Session-Id') ?? ''
    this.clientHash = request.headers.get('X-Client-Hash') ?? ''
    this.accountId = request.headers.get('X-Account-Id') || null
    this.accountName = request.headers.get('X-Account-Name') || null
    this.openedAt = Date.now()

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.socket = server
    server.addEventListener('message', (event) => this.onMessage(event.data))
    server.addEventListener('close', () => this.shutdown())
    server.addEventListener('error', () => this.shutdown())

    this.send({ type: 'hello', sessionId: this.sessionId, economyVersion: ECONOMY_VERSION })
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
    this.touch()
    return new Response(null, { status: 101, webSocket: client })
  }

  // --- transport -------------------------------------------------------------------------------

  private send(message: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message))
    } catch {
      this.shutdown()
    }
  }

  private fail(message: string, fatal = false): void {
    this.send({ type: 'error', message, fatal })
    if (fatal) {
      this.socket?.close(1008, message)
      this.shutdown()
    }
  }

  private touch(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.fail('Session timed out.', true), IDLE_TIMEOUT_MS)
  }

  private shutdown(): void {
    clearInterval(this.pingTimer)
    clearTimeout(this.idleTimer)
    this.active?.standoff.abort()
    this.socket = null
    if (this.openedAt > 0) {
      const seconds = (Date.now() - this.openedAt) / 1000
      this.openedAt = 0
      this.ctx.waitUntil(recordUsage(this.env, 'duel_seconds', seconds).catch(() => undefined))
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

  private onPong(n: number): void {
    const sentAt = this.pingSentAt.get(n)
    if (sentAt === undefined) {
      return
    }
    this.pingSentAt.delete(n)
    this.rttSamples.push(Date.now() - sentAt)
    if (this.rttSamples.length > RTT_SAMPLES) {
      this.rttSamples.shift()
    }
  }

  private onMessage(data: string | ArrayBuffer): void {
    const message = typeof data === 'string' ? parseMessage(data) : null
    if (!message) {
      this.fail('Malformed message.')
      return
    }
    if (message.type === 'pong') {
      this.onPong(message.n)
      return
    }
    this.touch()
    if (message.type === 'standoff') {
      this.onStandoff(message.duel, message.level)
    } else if (message.type === 'shot') {
      this.onShot(message.duel, message.target, message.localMs)
    } else if (message.type === 'finish') {
      this.onFinish(message.name).catch(() => this.fail('Could not record the run.', true))
    }
  }

  // --- duel flow -------------------------------------------------------------------------------

  private onStandoff(duel: number, level: number): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by other handlers; Biome only sees the initial value
    if (this.finished || this.complete) {
      this.fail('The run is over.')
      return
    }
    if (this.active && !this.active.done) {
      this.fail('A duel is already in progress.')
      return
    }
    if (!Number.isInteger(duel) || level !== this.expectedLevel) {
      this.fail('Out of order: ranked runs face each outlaw in turn, starting with the first.')
      return
    }
    const tuning = tuningFor(level, this.expectedPhase)
    if (!tuning) {
      this.fail('Unknown outlaw.')
      return
    }
    const phase = this.expectedPhase
    const standoff: Standoff = new Standoff({
      mode: 'ranked',
      seats: [
        { kind: 'human', link: () => ({ ...rttStats(this.rttSamples), tcp: null }) },
        outlawOpponent(tuning),
      ],
      plan: rankedWaitPlan(tuning),
      events: {
        cue: (cue) => this.send({ type: 'cue', duel, cue }),
        call: () => this.send({ type: 'call', duel }),
        end: (verdict, stats) => this.resolve(active, verdict, stats),
      },
    })
    const active: ActiveDuel = { duel, level, phase, standoff, done: false }
    this.active = active
    standoff.start()
  }

  private onShot(duel: number, target: number, localMs: number | null): void {
    const active = this.active
    if (!active || active.duel !== duel || active.done) {
      return
    }
    active.standoff.shot(0, typeof localMs === 'number' ? localMs : null, target)
  }

  private resolve(active: ActiveDuel, verdict: Verdict, stats: WaitStats): void {
    if (active.done || verdict.kind !== 'ranked') {
      return
    }
    active.done = true
    const { outcome, reactionMs } = verdict
    const record: DuelRecord = { level: active.level, outcome, reactionMs }

    const bossPhaseOne = active.level === BOSS_LEVEL && active.phase === 1
    let earned = 0
    if (outcome === 'win' && bossPhaseOne) {
      // Phase one only wounds him; the bounty is paid once, on the final kill.
      this.expectedPhase = 2
    } else {
      this.records.push(record)
      earned = payout(record)
      if (outcome === 'win') {
        this.winReactions.push(reactionMs ?? 0)
        this.expectedLevel++
        this.expectedPhase = 1
        this.complete = active.level >= LAST_LEVEL
      }
    }

    // The credit job is stored before the result is sent: the output gate holds the socket message
    // until the write is durable, so a result the player sees always has its credit on disk, and
    // the outbox retries it (from an alarm, across resets) until the D1 batch commits.
    const queued = this.accountId
      ? this.outbox.enqueue(String(active.duel).padStart(4, '0'), {
          accountId: this.accountId,
          runId: this.sessionId,
          level: active.level,
          paidWin: outcome === 'win' && !bossPhaseOne,
          ghost:
            active.level >= RANKED_GHOST_MIN_LEVEL
              ? {
                  reactionMs: outcome === 'coward' ? null : reactionMs,
                  fakesSeen: stats.fakesSeen,
                  fakeCoward: stats.coward?.onCue ?? false,
                  waitCoward: stats.coward !== null && !stats.coward.onCue,
                  waitedMs: stats.waitedMs,
                }
              : null,
        })
      : null

    this.send({
      type: 'result',
      duel: active.duel,
      outcome,
      reactionMs,
      enemyMs: verdict.enemyMs,
      payout: earned,
      purse: scoreRun(this.records),
      targetsHit: verdict.targetsHit,
    })

    if (queued) {
      this.ctx.waitUntil(
        queued.then(
          () => this.outbox.drain(),
          (err: unknown) => console.error('ranked credit could not be queued', err),
        ),
      )
    }
  }

  /**
   * One credit job: the gauntlet grant through stream C and ghost seeding from outlaw 6 up, in one
   * batch. Throws on failure so the outbox retries it.
   */
  private async applyCredit(job: CreditJob): Promise<void> {
    const statements: D1PreparedStatement[] = []
    if (job.paidWin) {
      statements.push(
        ...(await gauntletClearStatements(this.env, job.accountId, job.level, job.runId)),
      )
    }
    const ghost = job.ghost ? await this.loadGhost(job.accountId) : null
    let seeded: { snapshot: GhostSnapshot; recent: number[] } | null = null
    if (job.ghost && ghost) {
      const judged = job.ghost.reactionMs
      const recent = judged === null ? ghost.recent : [...ghost.recent, judged].slice(-GHOST_RING)
      seeded = { recent, snapshot: { ...ghost.snapshot, drawRating: drawRating(recent) } }
      statements.push(
        ...ghostRecordStatements(this.env, {
          accountId: job.accountId,
          source: 'ranked',
          froze: false,
          ...job.ghost,
          snapshot: seeded.snapshot,
        }),
      )
    }
    if (statements.length > 0) {
      await this.env.DB.batch(statements)
    }
    if (seeded) {
      // only once it committed, so a retried job doesn't count the sample twice in memory
      this.ghost = seeded
    }
  }

  private async loadGhost(
    accountId: string,
  ): Promise<{ snapshot: GhostSnapshot; recent: number[] } | null> {
    if (this.ghost) {
      return this.ghost
    }
    const profile = await getProfile(this.env, accountId)
    if (!profile) {
      return null
    }
    const { results } = await this.env.DB.prepare(
      `SELECT ms FROM ghost_samples WHERE account_id = ? ORDER BY id DESC LIMIT ${GHOST_RING}`,
    )
      .bind(accountId)
      .all<{ ms: number }>()
    const recent = results.map((r) => r.ms).reverse()
    this.ghost = {
      recent,
      snapshot: {
        name: profile.name,
        level: profile.level,
        prestige: profile.prestige,
        loadout: profile.loadout,
        drawRating: drawRating(recent),
      },
    }
    return this.ghost
  }

  // --- finish ----------------------------------------------------------------------------------

  /** The leaderboard name: the account's own for a signed-in run; a guest may not take an owned one. */
  private async boardName(rawName: string): Promise<NameResult> {
    if (this.accountId && this.accountName) {
      return validateName(this.accountName)
    }
    const name = validateName(rawName)
    if (name.ok && (await isNameOwned(this.env, name.key))) {
      return { ok: false, error: 'That name belongs to a registered gunslinger. Pick another.' }
    }
    return name
  }

  private async onFinish(rawName: string): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by other handlers; Biome only sees the initial value
    if (this.finished) {
      return
    }
    const name = await this.boardName(rawName)
    if (!name.ok) {
      this.fail(name.error)
      return
    }
    this.finished = true
    this.active?.standoff.abort()
    const total = Math.max(0, Math.round(scoreRun(this.records)))
    const flagged = looksAutomated(this.winReactions) ? 1 : 0
    const db = this.env.DB

    if (total > 0) {
      await db
        .prepare(
          `INSERT INTO runs (id, name, name_key, total, duels, wins, economy_version, client_hash,
                             created_at, flagged, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          name.name,
          name.key,
          total,
          this.records.length,
          this.winReactions.length,
          ECONOMY_VERSION,
          this.clientHash,
          Date.now(),
          flagged,
          this.sessionId,
        )
        .run()
    }
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS ahead FROM (
           SELECT name_key, MAX(total) AS best FROM runs WHERE flagged = 0 GROUP BY name_key
         ) WHERE best > ? AND name_key != ?`,
      )
      .bind(total, name.key)
      .first<{ ahead: number }>()
    this.send({ type: 'final', total, rank: (row?.ahead ?? 0) + 1 })
    this.socket?.close(1000, 'Run recorded')
    this.shutdown()
  }
}
