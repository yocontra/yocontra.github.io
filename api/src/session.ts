/**
 * DuelSession: one Durable Object per ranked run. The server owns the clock: it picks the wait,
 * plays the fake-outs, sends the call, samples the outlaw's draw, judges every shot with latency
 * compensation, and keeps the purse. The client only renders what it is told.
 *
 * The duel itself runs on the shared standoff engine (`duel/standoff.ts`) with an outlaw opponent.
 * A run may belong to a signed-in account (optional): its wins then pay gauntlet XP and dollars
 * through stream C, its duels against outlaw 6 and up seed the player's ghost, and the leaderboard
 * entry uses the account name.
 *
 * **Resume** (`contract/ranked.ts`): the run's progress is stored (`ranked/run-state.ts`) before
 * any result goes out, so a client that drops, or finds the object restarted, reconnects with its
 * resume token within 30 s and carries on from the same outlaw with the same purse. A duel in
 * progress at the drop is voided: never judged, never paid, and faced again under a new number.
 */
import { DurableObject } from 'cloudflare:workers'
import {
  RANKED_RESUME_WINDOW_MS,
  type RankedServerMessage,
} from '../../src/experiments/out-west/contract/ranked.ts'
import {
  type DuelRecord,
  ECONOMY_VERSION,
  payout,
  scoreRun,
} from '../../src/experiments/out-west/data/economy.ts'
import { recordUsage } from './budget.ts'
import { CreditOutbox } from './duel/credit-outbox.ts'
import { isNameOwned } from './duel/external.ts'
import { outlawOpponent } from './duel/opponents.ts'
import {
  CALL_LEAD_MS,
  rankedWaitPlan,
  Standoff,
  type Verdict,
  type WaitStats,
} from './duel/standoff.ts'
import type { Env } from './env.ts'
import { rttStats } from './judge.ts'
import { type NameResult, validateName } from './names.ts'
import { PING_INTERVAL_MS, RTT_SAMPLES } from './net/constants.ts'
import { creditJobFor, RankedCredits } from './ranked/credit.ts'
import { recordRun } from './ranked/finish.ts'
import {
  newRun,
  type Phase,
  RUN_KEY,
  type RunState,
  resumedInfo,
  resumeVerdict,
} from './ranked/run-state.ts'
import { BOSS_LEVEL, LAST_LEVEL, tuningFor } from './tuning.ts'

/** Kept for older imports; the session sees the whole Worker environment. */
export type SessionEnv = Env

const IDLE_TIMEOUT_MS = 15 * 60 * 1000
/** Close code for a socket replaced by a resume from elsewhere. */
const REPLACED = 4000
/** The expiry alarm fires a moment after the window, so the verdict is unambiguous. */
const RESUME_ALARM_SLACK_MS = RANKED_RESUME_WINDOW_MS + 1000

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
  private openedAt = 0
  /** The run's stored progress. Null until the first socket (or loaded from storage). */
  private run: RunState | null = null
  private active: ActiveDuel | null = null

  private pingSeq = 0
  private readonly pingSentAt = new Map<number, number>()
  private rttSamples: number[] = []
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  /** Applies credit jobs (gauntlet grants, reward items, ghost seeding). */
  private readonly credits = new RankedCredits(this.env, (p) => this.ctx.waitUntil(p))

  /** Account credits owed by judged duels, durable until their D1 batch commits. */
  private readonly outbox = new CreditOutbox({
    storage: this.ctx.storage,
    apply: (job) => this.credits.apply(job),
  })

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.run = (await ctx.storage.get<RunState>(RUN_KEY)) ?? null
    })
  }

  /** Retries credits that failed (also after a reset), and closes a run whose window passed. */
  override async alarm(): Promise<void> {
    await this.outbox.drain()
    const run = this.run
    if (!run || this.socket || run.finished) {
      return
    }
    if (resumeVerdict(run, Date.now(), false) === 'expired') {
      await this.expire(run)
    } else {
      // The outbox may have moved the alarm; keep the expiry armed.
      await this.armExpiry(run)
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const resuming = request.headers.get('X-Resume') === '1'
    const now = Date.now()
    const admitted = resuming ? await this.resume(now) : this.start(request, now)
    if (admitted instanceof Response) {
      return admitted
    }
    const { run, voided } = admitted
    run.droppedAt = null
    await this.save(run)

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.socket = server
    this.openedAt = now
    this.rttSamples = []
    server.addEventListener('message', (event) => {
      if (this.socket === server) {
        this.onMessage(event.data)
      }
    })
    server.addEventListener('close', () => this.onDrop(server))
    server.addEventListener('error', () => this.onDrop(server))

    this.send({
      type: 'hello',
      sessionId: run.sessionId,
      economyVersion: ECONOMY_VERSION,
      ...(resuming ? { resumed: resumedInfo(run, voided) } : {}),
    })
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
    this.touch()
    return new Response(null, { status: 101, webSocket: client })
  }

  /** A resume: the stored run, if its window is still open. The duel in progress is voided. */
  private async resume(now: number): Promise<{ run: RunState; voided: number | null } | Response> {
    const run = this.run
    if (!run) {
      return new Response('No run to resume', { status: 410 })
    }
    const verdict = resumeVerdict(run, now, this.socket !== null)
    if (verdict !== 'ok') {
      if (verdict === 'expired') {
        await this.expire(run)
      }
      return new Response('The run is over', { status: 410 })
    }
    const voided = this.voidActive()
    this.replaceSocket()
    return { run, voided }
  }

  /** A first connect: a new run (a session is used once; later sockets must resume). */
  private start(request: Request, now: number): { run: RunState; voided: null } | Response {
    if (this.run) {
      return new Response('Session already used', { status: 409 })
    }
    const run = newRun({
      sessionId: request.headers.get('X-Session-Id') ?? '',
      clientHash: request.headers.get('X-Client-Hash') ?? '',
      accountId: request.headers.get('X-Account-Id') || null,
      accountName: request.headers.get('X-Account-Name') || null,
      now,
    })
    this.run = run
    return { run, voided: null }
  }

  // --- persistence -----------------------------------------------------------------------------

  private async save(run: RunState): Promise<void> {
    run.savedAt = Date.now()
    await this.ctx.storage.put(RUN_KEY, run)
  }

  /** Stops the duel in progress, unjudged. Its number stays recorded until a resume reports it. */
  private abortActive(): void {
    const active = this.active
    this.active = null
    if (active && !active.done) {
      active.done = true
      active.standoff.abort()
    }
  }

  /** A duel in progress is voided: aborted unjudged, never paid. Returns its number. */
  private voidActive(): number | null {
    this.abortActive()
    // From storage, so a duel cut off by a restart (no `active` in memory any more) is reported too.
    const run = this.run
    const voided = run?.inProgress ?? null
    if (run) {
      run.inProgress = null
    }
    return voided
  }

  /** The window passed with no resume: a signed-in run is recorded as it stood. */
  private async expire(run: RunState): Promise<void> {
    if (run.finished) {
      return
    }
    run.finished = true
    await this.save(run)
    if (run.accountId && run.accountName) {
      const name = validateName(run.accountName)
      if (name.ok) {
        await recordRun(this.env, run, name).catch((err: unknown) =>
          console.error('expired run could not be recorded', err),
        )
      }
    }
  }

  // --- transport -------------------------------------------------------------------------------

  private send(message: RankedServerMessage): void {
    try {
      this.socket?.send(JSON.stringify(message))
    } catch {
      if (this.socket) {
        this.onDrop(this.socket)
      }
    }
  }

  private fail(message: string, fatal = false): void {
    this.send({ type: 'error', message, fatal })
    if (fatal) {
      const socket = this.socket
      socket?.close(1008, message)
      if (socket) {
        this.onDrop(socket)
      }
    }
  }

  private touch(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.fail('Session timed out.', true), IDLE_TIMEOUT_MS)
  }

  /** Stops the current socket's timers and bills its time (duel_seconds, §14 budget). */
  private detach(): void {
    clearInterval(this.pingTimer)
    clearTimeout(this.idleTimer)
    this.socket = null
    if (this.openedAt > 0) {
      const seconds = (Date.now() - this.openedAt) / 1000
      this.openedAt = 0
      this.ctx.waitUntil(recordUsage(this.env, 'duel_seconds', seconds).catch(() => undefined))
    }
  }

  /** A resume takes over from a socket that is still open (a second tab, a half-dead link). */
  private replaceSocket(): void {
    const old = this.socket
    if (!old) {
      return
    }
    this.detach()
    try {
      old.close(REPLACED, 'replaced')
    } catch {
      // Already gone.
    }
  }

  /** The socket went away. The run waits for a resume; the duel in progress is voided. */
  private onDrop(ws: WebSocket): void {
    if (ws !== this.socket) {
      return
    }
    this.detach()
    this.abortActive()
    const run = this.run
    if (run && !run.finished) {
      run.droppedAt = Date.now()
      this.ctx.waitUntil(this.save(run).then(() => this.armExpiry(run)))
    }
  }

  /** Wake when the resume window closes (the outbox shares the alarm; both are handled there). */
  private async armExpiry(run: RunState): Promise<void> {
    const at = (run.droppedAt ?? Date.now()) + RESUME_ALARM_SLACK_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) {
      await this.ctx.storage.setAlarm(at)
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
    const run = this.run
    if (!run || run.finished || run.complete) {
      this.fail('The run is over.')
      return
    }
    if (this.active && !this.active.done) {
      this.fail('A duel is already in progress.')
      return
    }
    if (!Number.isInteger(duel) || duel < run.nextDuel) {
      this.fail(`Duel numbers only go up: use ${run.nextDuel} or more.`)
      return
    }
    if (level !== run.level) {
      this.fail('Ranked runs go in order, starting with outlaw 1.')
      return
    }
    const tuning = tuningFor(level, run.phase)
    if (!tuning) {
      this.fail('Unknown outlaw.')
      return
    }
    run.nextDuel = duel + 1
    run.inProgress = duel
    void this.save(run)
    const phase = run.phase
    const standoff: Standoff = new Standoff({
      mode: 'ranked',
      seats: [
        { kind: 'human', link: () => ({ ...rttStats(this.rttSamples), tcp: null }) },
        outlawOpponent(tuning),
      ],
      plan: rankedWaitPlan(tuning),
      leadMs: CALL_LEAD_MS,
      events: {
        cue: (cue) => this.send({ type: 'cue', duel, cue }),
        call: (_seat, inMs) => this.send({ type: 'call', duel, inMs }),
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
    const run = this.run
    if (!run || active.done || verdict.kind !== 'ranked' || this.active !== active) {
      return
    }
    active.done = true
    run.inProgress = null
    const { outcome, reactionMs } = verdict
    const record: DuelRecord = { level: active.level, outcome, reactionMs }

    const bossPhaseOne = active.level === BOSS_LEVEL && active.phase === 1
    let earned = 0
    if (outcome === 'win' && bossPhaseOne) {
      // Phase one only wounds him; the bounty is paid once, on the final kill.
      run.phase = 2
    } else {
      run.records.push(record)
      earned = payout(record)
      if (outcome === 'win') {
        run.winReactions.push(reactionMs ?? 0)
        run.level++
        run.phase = 1
        run.complete = active.level >= LAST_LEVEL
      }
    }
    run.coward ||= outcome === 'coward'
    // Progress is stored before the result goes out (the output gate holds the message until the
    // write is durable), so a resumed run always continues from what the player was told.
    void this.save(run)

    // The credit job is stored before the result is sent too, and the outbox retries it (from an
    // alarm, across resets) until the D1 batch commits.
    const queued = run.accountId
      ? this.outbox.enqueue(
          String(active.duel).padStart(4, '0'),
          creditJobFor(run, { level: active.level, outcome, reactionMs, stats, bossPhaseOne }),
        )
      : null

    this.send({
      type: 'result',
      duel: active.duel,
      outcome,
      reactionMs,
      enemyMs: verdict.enemyMs,
      payout: earned,
      purse: scoreRun(run.records),
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

  // --- finish ----------------------------------------------------------------------------------

  /** The leaderboard name: the account's own for a signed-in run; a guest may not take an owned one. */
  private async boardName(run: RunState, rawName: string): Promise<NameResult> {
    if (run.accountId && run.accountName) {
      return validateName(run.accountName)
    }
    const name = validateName(rawName)
    if (name.ok && (await isNameOwned(this.env, name.key))) {
      return { ok: false, error: 'That name is taken. Pick another.' }
    }
    return name
  }

  private async onFinish(rawName: string): Promise<void> {
    const run = this.run
    if (!run || run.finished) {
      return
    }
    const name = await this.boardName(run, rawName)
    if (!name.ok) {
      this.fail(name.error)
      return
    }
    run.finished = true
    this.voidActive()
    await this.save(run)
    const { total, rank } = await recordRun(this.env, run, name)
    this.send({ type: 'final', total, rank })
    const socket = this.socket
    socket?.close(1000, 'Run recorded')
    if (socket) {
      this.onDrop(socket)
    }
  }
}
