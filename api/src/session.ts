/**
 * DuelSession: one Durable Object per ranked run. The server owns the clock: it picks the wait,
 * plays the fake-outs, sends the call, samples the outlaw's draw, judges every shot with latency
 * compensation, and keeps the purse. The client only renders what it is told.
 */
import { DurableObject } from 'cloudflare:workers'
import {
  type DuelRecord,
  ECONOMY_VERSION,
  payout,
  scoreRun,
} from '../../src/experiments/out-west/data/economy.ts'
import { judgedReaction, looksAutomated, MIN_REACTION_MS, rttStats, tolerance } from './judge.ts'
import { validateName } from './names.ts'
import { BOSS_LEVEL, type DuelTuning, LAST_LEVEL, tuningFor } from './tuning.ts'

export interface SessionEnv {
  DB: D1Database
}

type Phase = 1 | 2

/** A missed first shot gives the player this much longer before the outlaw's second one lands. */
const MISS_GRACE_MS = 250
const PING_INTERVAL_MS = 400
const RTT_SAMPLES = 12
const IDLE_TIMEOUT_MS = 15 * 60 * 1000
const MIN_FAKE_GAP_MS = 350

interface Enemy {
  /** When this enemy's shot lands, measured from the call as the player hears it. */
  landsAtMs: number
  alive: boolean
}

interface ActiveDuel {
  duel: number
  level: number
  phase: Phase
  tuning: DuelTuning
  state: 'waiting' | 'called' | 'done'
  callSentAt: number
  enemies: Enemy[]
  firstReaction: number | null
  timers: ReturnType<typeof setTimeout>[]
}

type ClientMessage =
  | { type: 'standoff'; duel: number; level: number }
  | { type: 'shot'; duel: number; target: number; localMs: number | null }
  | { type: 'pong'; n: number }
  | { type: 'finish'; name: string }

const between = (min: number, max: number): number => min + Math.random() * (max - min)

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

export class DuelSession extends DurableObject<SessionEnv> {
  private socket: WebSocket | null = null
  private sessionId = ''
  private clientHash = ''
  private used = false
  private finished = false

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
    this.clearDuelTimers()
    this.socket = null
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

  private clearDuelTimers(): void {
    for (const timer of this.active?.timers ?? []) {
      clearTimeout(timer)
    }
  }

  private onStandoff(duel: number, level: number): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by other handlers; Biome only sees the initial value
    if (this.finished || this.complete) {
      this.fail('The run is over.')
      return
    }
    if (this.active && this.active.state !== 'done') {
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
    this.active = {
      duel,
      level,
      phase: this.expectedPhase,
      tuning,
      state: 'waiting',
      callSentAt: 0,
      enemies: [],
      firstReaction: null,
      timers: [],
    }
    this.scheduleWait(this.active)
  }

  private scheduleWait(active: ActiveDuel): void {
    const { tuning } = active
    let callAt: number
    if (tuning.sequence) {
      // The boss's clock: strikes at random intervals, the call lands on the final one.
      let at = 0
      for (const cue of tuning.sequence.cues) {
        at += between(...tuning.sequence.intervalMs)
        active.timers.push(setTimeout(() => this.send({ type: 'cue', duel: active.duel, cue }), at))
      }
      callAt = at + between(...tuning.sequence.intervalMs)
    } else {
      callAt = between(...tuning.waitMs)
    }

    const cue = tuning.cues[Math.floor(Math.random() * tuning.cues.length)]
    if (cue && Math.random() < tuning.fakeChance && callAt > MIN_FAKE_GAP_MS * 2) {
      const fakeAt = between(MIN_FAKE_GAP_MS, callAt - MIN_FAKE_GAP_MS)
      active.timers.push(
        setTimeout(() => this.send({ type: 'cue', duel: active.duel, cue }), fakeAt),
      )
    }
    active.timers.push(setTimeout(() => this.call(active), callAt))
  }

  private call(active: ActiveDuel): void {
    if (active.state !== 'waiting' || this.active !== active) {
      return
    }
    active.enemies = active.tuning.targets.map((target) => {
      const draw = target.drawMs + between(-target.jitterMs, target.jitterMs)
      const hits = Math.random() < target.accuracy
      return { landsAtMs: hits ? draw : draw + MISS_GRACE_MS, alive: true }
    })
    active.state = 'called'
    active.callSentAt = Date.now()
    this.send({ type: 'call', duel: active.duel })

    // If the player never fires, the first outlaw to shoot wins. Allow for the round trip.
    const rtt = rttStats(this.rttSamples)
    const firstLanding = Math.min(...active.enemies.map((e) => e.landsAtMs))
    const deadline = firstLanding + rtt.median + tolerance(rtt) + 50
    active.timers.push(setTimeout(() => this.resolve(active, 'loss'), deadline))
  }

  private onShot(duel: number, target: number, localMs: number | null): void {
    const active = this.active
    if (!active || active.duel !== duel || active.state === 'done') {
      return
    }
    if (active.state === 'waiting') {
      this.resolve(active, 'coward', -1)
      return
    }
    const rtt = rttStats(this.rttSamples)
    const observed = Date.now() - active.callSentAt
    const reaction = judgedReaction(observed, typeof localMs === 'number' ? localMs : null, rtt)

    if (reaction < MIN_REACTION_MS) {
      // Anticipation, not reaction: treated exactly like drawing before the call.
      this.resolve(active, 'coward', -1)
      return
    }
    if (active.enemies.some((e) => e.alive && e.landsAtMs <= reaction)) {
      this.resolve(active, 'loss', active.firstReaction ?? reaction)
      return
    }
    active.firstReaction ??= reaction
    const index = Number.isInteger(target) ? target : 0
    const enemy = active.enemies[index] ?? active.enemies.find((e) => e.alive)
    if (enemy) {
      enemy.alive = false
    }
    if (active.enemies.every((e) => !e.alive)) {
      this.resolve(active, 'win', active.firstReaction)
    }
  }

  private resolve(active: ActiveDuel, outcome: DuelRecord['outcome'], reaction?: number): void {
    if (active.state === 'done') {
      return
    }
    active.state = 'done'
    this.clearDuelTimers()
    const reactionMs = reaction === undefined ? null : Math.round(reaction)
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

    this.send({
      type: 'result',
      duel: active.duel,
      outcome,
      reactionMs,
      enemyMs:
        active.enemies.length > 0
          ? Math.round(Math.min(...active.enemies.map((e) => e.landsAtMs)))
          : null,
      payout: earned,
      purse: scoreRun(this.records),
      targetsHit: active.enemies.filter((e) => !e.alive).length,
    })
  }

  // --- finish ----------------------------------------------------------------------------------

  private async onFinish(rawName: string): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by other handlers; Biome only sees the initial value
    if (this.finished) {
      return
    }
    const name = validateName(rawName)
    if (!name.ok) {
      this.fail(name.error)
      return
    }
    this.finished = true
    this.clearDuelTimers()
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
