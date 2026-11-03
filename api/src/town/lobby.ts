/**
 * One Frontier lobby: the authoritative 20 Hz tick, **only while a human is present**. When the
 * last human leaves (after their 10 s linger), the loop stops, everything is flushed and the object
 * goes idle, so an empty lobby costs nothing. Bots never keep it awake. Owned by stream F.
 *
 * Money: deposits are settled in D1 every 2 s (each idempotent under its own key, persisted to DO
 * storage first so a failed batch retries under the same key). Carried cash lives in memory only.
 */
import { DurableObject } from 'cloudflare:workers'
import { TICK_MS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { recordUsage } from '../budget.ts'
import { getProfile } from '../economy/profile.ts'
import type { Env } from '../env.ts'
import { FLAG_BADLANDS, flagStatements, isShadowed, standing } from '../moderation/flags.ts'
import {
  type Departure,
  FLAG_AIMBOT,
  LobbyCore,
  type SettledDeposit,
  type TickOutput,
} from './core.ts'
import {
  depositKey,
  depositStatements,
  lobbyStatsStatement,
  sessionStartStatement,
  xpFlushStatements,
} from './settle.ts'
import { SocketPeer } from './socket-peer.ts'

const DEPOSIT_FLUSH_MS = 2000
const MINUTE_MS = 60_000
const DIRECTORY_DEBOUNCE_MS = 5000
const MAX_CATCH_UP_TICKS = 4
const MAX_DEV_BOTS = 31
const DIRECTORY = 'dir:global'

export interface LobbyStats {
  lobbyId: string
  running: boolean
  humans: number
  bodies: number
  ticks: number
  bytesOut: number
  msgsIn: number
  msgsOut: number
  droppedIn: number
  tickMs: { p50: number; p95: number; p99: number; max: number; samples: number }
  minted: number
  burned: number
}

export class Lobby extends DurableObject<Env> {
  private core: LobbyCore | null = null
  private lobbyId = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private epoch = 0
  private ticksRun = 0
  private readonly pending = new Map<string, SettledDeposit>()
  /** Sessions whose aimbot flag has been written to `accounts.flags` already. */
  private readonly aimbotFlagged = new Set<string>()
  private flushing: boolean
  private lastDepositFlush = 0
  private lastMinute = 0
  private occupiedSince = 0
  private msgsReported = 0
  private mintedReported = 0
  private burnedReported = 0
  private depositedSinceReport = 0
  private killsSinceReport = 0
  private peakHumans = 0
  private readonly arrived: string[] = []
  private readonly departed: string[] = []
  private lastDirectoryReport = 0
  private tickDurations: number[] = []

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.flushing = false
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.list<SettledDeposit & { lobbyId: string }>({ prefix: 'dep:' })
      for (const [key, d] of saved) {
        this.pending.set(key.slice(4), d)
        this.lobbyId ||= d.lobbyId
      }
    })
  }

  private dev(): boolean {
    return this.env.RP_ID === 'localhost'
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/stats') {
      return Response.json(this.stats())
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    this.lobbyId = request.headers.get('X-Lobby-Id') ?? this.lobbyId
    const accountId = request.headers.get('X-Account-Id') ?? ''
    const name = request.headers.get('X-Name') ?? ''
    if (!(accountId && this.lobbyId)) {
      return new Response('Bad join', { status: 400 })
    }
    const [profile, standingNow] = await Promise.all([
      getProfile(this.env, accountId),
      standing(this.env, accountId),
    ])
    if (!(profile || this.dev())) {
      return new Response('No profile', { status: 403 })
    }
    this.core ??= new LobbyCore(this.lobbyId, crypto.getRandomValues(new Uint32Array(1))[0] ?? 1)
    const core = this.core
    const bots = Number(request.headers.get('X-Bots') ?? 0)
    if (this.dev() && bots > 0) {
      core.botTarget = Math.min(MAX_DEV_BOTS, Math.max(core.botTarget, bots))
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    // Newer compatibility dates deliver binary frames as Blob by default; the codec wants bytes.
    server.binaryType = 'arraybuffer'
    server.accept()
    const peer = new SocketPeer(server)
    const tcp = Number(request.headers.get('X-Tcp-Rtt'))
    const session = core.join(
      {
        accountId,
        name: profile?.name || name,
        level: profile?.level ?? 1,
        prestige: profile?.prestige ?? 0,
        loadout: profile ? Object.values(profile.loadout) : [],
        banked: profile?.purse ?? 0,
        tcpRtt: Number.isFinite(tcp) && tcp > 0 ? tcp : null,
        ledger: profile !== null,
        frozen: isShadowed(standingNow.flags),
        blocked: standingNow.blocked,
      },
      peer,
      Date.now(),
    )
    if (!session) {
      server.close(4001, 'The town is full.')
      return new Response(null, { status: 101, webSocket: client })
    }
    const id = session.playerId
    server.addEventListener('message', (event) => {
      const data = event.data
      if (typeof data === 'string') {
        core.onText(id, data, Date.now())
      } else {
        core.onBinary(id, data, Date.now())
      }
    })
    const drop = (): void => {
      core.disconnect(id, peer)
      this.onDisconnect(core, id)
    }
    server.addEventListener('close', drop)
    server.addEventListener('error', drop)
    if (session.ledger) {
      this.ctx.waitUntil(
        sessionStartStatement(this.env, this.lobbyId, session)
          .run()
          .catch(() => undefined),
      )
    }
    this.arrived.push(accountId)
    this.start()
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Flush at disconnect, not only when the 10 s linger ends: with no sockets left the runtime may
   * evict the object before the linger finishes, and stats or usage must not be lost with it.
   */
  private onDisconnect(core: LobbyCore, playerId: number): void {
    const s = core.sessionOf(playerId)
    const p = core.world.players[playerId]
    if (s && p) {
      void this.flushXp({ session: s, player: p }, Date.now())
    }
    if (core.connectedHumans() === 0) {
      void this.flushDeposits()
      void this.minute(core, Date.now())
    }
  }

  // --- The loop ---------------------------------------------------------------------------------

  private start(): void {
    if (this.timer !== undefined) {
      return
    }
    const now = Date.now()
    this.epoch = now
    this.ticksRun = 0
    this.lastMinute = now
    this.lastDepositFlush = now
    this.occupiedSince = now
    this.timer = setInterval(() => this.loop(), TICK_MS)
    this.reportDirectory(true)
  }

  private loop(): void {
    const core = this.core
    if (!core) {
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.epoch) / TICK_MS) - this.ticksRun
    if (due > MAX_CATCH_UP_TICKS) {
      // Fell behind (a long GC or a slow event): skip ahead rather than spiral.
      this.ticksRun += due - 1
      due = 1
    }
    for (let i = 0; i < due; i++) {
      const t0 = performance.now()
      this.handle(core.tick(now))
      this.tickDurations.push(performance.now() - t0)
      this.ticksRun++
    }
    if (this.tickDurations.length > 2400) {
      this.tickDurations = this.tickDurations.slice(-1200)
    }
    this.peakHumans = Math.max(this.peakHumans, core.humans())
    if (now - this.lastDepositFlush >= DEPOSIT_FLUSH_MS) {
      this.lastDepositFlush = now
      void this.flushDeposits()
    }
    if (now - this.lastMinute >= MINUTE_MS) {
      this.lastMinute = now
      void this.minute(core, now)
    }
    this.reportDirectory(false)
    if (core.humans() === 0) {
      this.stop(core, now)
    }
  }

  private handle(out: TickOutput): void {
    const core = this.core
    for (const d of out.deposits) {
      const s = core?.sessionOf(d.playerId)
      this.depositedSinceReport += d.amount + d.commission
      if (s?.ledger === false) {
        // Dev account without a profile: nothing to settle.
        core?.confirmDeposit(d, true)
        continue
      }
      const key = depositKey(this.lobbyId, d)
      this.pending.set(key, d)
      void this.ctx.storage.put(`dep:${key}`, { ...d, lobbyId: this.lobbyId })
    }
    for (const ev of core?.world.events ?? []) {
      if (ev.type === 'kill') {
        this.killsSinceReport++
      }
    }
    for (const dep of out.departures) {
      this.departed.push(dep.session.accountId)
      void this.flushXp(dep, Date.now())
    }
  }

  private stop(core: LobbyCore, now: number): void {
    clearInterval(this.timer)
    this.timer = undefined
    void this.flushDeposits()
    void this.minute(core, now)
    this.reportDirectory(true)
    // Nobody's left, so nothing of value is in the world: start fresh next time.
    this.core = null
  }

  // --- Settlement -------------------------------------------------------------------------------

  private async flushDeposits(): Promise<void> {
    if (this.flushing || this.pending.size === 0) {
      return
    }
    this.flushing = true
    try {
      for (const [key, d] of [...this.pending]) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: one batch per deposit keeps failures independent
          await this.env.DB.batch(depositStatements(this.env, this.lobbyId, d))
          this.pending.delete(key)
          await this.ctx.storage.delete(`dep:${key}`)
          this.core?.confirmDeposit(d, true)
        } catch (err) {
          console.error('ffa deposit failed; will retry', key, err)
          this.core?.confirmDeposit(d, false)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private async flushXp(dep: Departure, leftAt: number | null): Promise<void> {
    const { session: s, player: p } = dep
    if (!s.ledger) {
      return
    }
    const { statements, xp } = xpFlushStatements(this.env, {
      session: s,
      player: p,
      flushIndex: s.xpFlushIndex,
      leftAt,
    })
    // The aimbot heuristic (§3.7) flags the account (§8): it rides in the Badlands from its next
    // join. Written once per session, in the same batch as the stats that carry the evidence.
    const flagNow = (s.flags & FLAG_AIMBOT) !== 0 && !this.aimbotFlagged.has(s.sessionId)
    if (flagNow) {
      statements.push(
        ...flagStatements(this.env, {
          accountId: s.accountId,
          bits: FLAG_BADLANDS,
          source: 'aimbot',
          detail: `${p.stats.hits}/${p.stats.shots} hits, ${p.stats.snapHits} snaps`,
        }),
      )
    }
    try {
      await this.env.DB.batch(statements)
      s.xpFlushed += xp
      if (xp > 0) {
        s.xpFlushIndex++
      }
      if (flagNow) {
        this.aimbotFlagged.add(s.sessionId)
      }
    } catch (err) {
      console.error('ffa xp flush failed', s.sessionId, err)
    }
  }

  /** Once a minute (and on stop): XP flushes, usage for the budget meter, lobby stats. */
  private async minute(core: LobbyCore, now: number): Promise<void> {
    const flushes = [...core.sessions.values()].flatMap((s) => {
      const p = core.world.players[s.playerId]
      return p ? [this.flushXp({ session: s, player: p }, null)] : []
    })
    const seconds = (now - this.occupiedSince) / 1000
    this.occupiedSince = now
    const msgs = core.metrics.msgsIn - this.msgsReported
    this.msgsReported = core.metrics.msgsIn
    const minted = core.world.minted - this.mintedReported
    const burned = core.world.burned - this.burnedReported
    this.mintedReported = core.world.minted
    this.burnedReported = core.world.burned
    const stats = lobbyStatsStatement(this.env, this.lobbyId, {
      occupiedSeconds: seconds,
      peakHumans: this.peakHumans,
      messagesIn: msgs,
      minted,
      burned,
      deposited: this.depositedSinceReport,
      kills: this.killsSinceReport,
    })
    this.depositedSinceReport = 0
    this.killsSinceReport = 0
    this.peakHumans = core.humans()
    if (this.core !== core) {
      // Stopped: the next start begins new counters.
      this.msgsReported = 0
      this.mintedReported = 0
      this.burnedReported = 0
    }
    await Promise.allSettled([
      ...flushes,
      recordUsage(this.env, 'lobby_seconds', seconds),
      recordUsage(this.env, 'ws_messages', msgs),
      stats.run(),
    ])
  }

  // --- Directory --------------------------------------------------------------------------------

  private reportDirectory(force: boolean): void {
    const now = Date.now()
    const changed = this.arrived.length > 0 || this.departed.length > 0
    if (!(force || (changed && now - this.lastDirectoryReport >= DIRECTORY_DEBOUNCE_MS))) {
      return
    }
    this.lastDirectoryReport = now
    const report = {
      lobbyId: this.lobbyId,
      humans: this.core?.humans() ?? 0,
      arrived: this.arrived.splice(0),
      departed: this.departed.splice(0),
    }
    const dir = this.env.LOBBY_DIR.get(this.env.LOBBY_DIR.idFromName(DIRECTORY))
    this.ctx.waitUntil(
      dir.report(report).catch((err: unknown) => console.error('directory report failed', err)),
    )
  }

  private stats(): LobbyStats {
    const sorted = this.tickDurations.toSorted((a, b) => a - b)
    const pct = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
    const core = this.core
    return {
      lobbyId: this.lobbyId,
      running: this.timer !== undefined,
      humans: core?.humans() ?? 0,
      bodies: core ? core.world.players.filter(Boolean).length : 0,
      ticks: core?.metrics.ticks ?? 0,
      bytesOut: core?.metrics.bytesOut ?? 0,
      msgsIn: core?.metrics.msgsIn ?? 0,
      msgsOut: core?.metrics.msgsOut ?? 0,
      droppedIn: core?.metrics.droppedIn ?? 0,
      tickMs: {
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
        max: sorted.at(-1) ?? 0,
        samples: sorted.length,
      },
      minted: core?.world.minted ?? 0,
      burned: core?.world.burned ?? 0,
    }
  }
}
