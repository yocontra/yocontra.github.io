// biome-ignore-all lint/suspicious/noUnnecessaryConditions: Durable Object fields change between awaited calls
// biome-ignore-all lint/style/noExcessiveLinesPerFile: voice lifecycle and the existing room/lobby flow live together
/**
 * One Frontier lobby: the authoritative 20 Hz tick, **only while a human is present**. When the
 * last online human leaves, the loop stops immediately, everything is flushed and the object
 * goes idle, so an empty lobby costs nothing. Bots never keep it awake. Owned by stream F.
 *
 * Money: deposits are settled in D1 every 2 s (each idempotent under its own key, persisted to DO
 * storage first so a failed batch retries under the same key). Carried cash lives in memory only.
 */

import { DurableObject } from 'cloudflare:workers'
import { connectClientToRoom, createAuthContext } from '@colyseus/core'
import { bagStyleIndex } from '../../../src/experiments/out-west/contract/town.ts'
import { budgetState, recordUsage } from '../budget.ts'
import { getProfile } from '../economy/profile.ts'
import { dyesOf } from '../economy/sinks.ts'
import type { Env } from '../env.ts'
import { NativeBudgetRefusal } from '../game/admission.ts'
import { createNativeRoom, type NativeFrontierRoom, reserveNativeRoom } from '../game/room.ts'
import { NativeSeats } from '../game/seats.ts'
import { CloudflareClient } from '../game/socket.ts'
import { FLAG_BADLANDS, flagStatements, isShadowed, standing } from '../moderation/flags.ts'
import { VoiceCoordinator, type VoiceStorage } from '../voice/coordinator.ts'
import {
  type Departure,
  FLAG_AIMBOT,
  LobbyCore,
  type Session,
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
import { lobbyUpgradeError } from './wire.ts'

const DIRECTORY_DEBOUNCE_MS = 5000
const DIRECTORY = 'dir:global'
interface NativeVisit {
  sessionId: string
  lobbyId: string
}
interface PendingXp {
  xp: number
  flushIndex: number
  stats: import('../../../src/experiments/out-west/ffa/sim/types.ts').Player['stats']
  flags: number
  flagNow: boolean
  leftAt: number | null
}

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
  links: { playerId: number; rtt: number[]; tcpRtt: number | null }[]
  tickMs: { p50: number; p95: number; p99: number; max: number; samples: number }
  minted: number
  burned: number
}

export class Lobby extends DurableObject<Env> {
  private readonly seats: NativeSeats
  private nativeLeaseId = ''
  private nativeLeaseTimer: ReturnType<typeof setTimeout> | undefined
  private nativeLeaseWatchdog: ReturnType<typeof setTimeout> | undefined
  private nativeLeaseMessages = 0
  private native: NativeFrontierRoom | undefined
  private nativeInitializing: Promise<NativeFrontierRoom> | undefined
  private readonly nativeClients = new Map<WebSocket, CloudflareClient>()
  private readonly nativeVisits = new Map<string, NativeVisit>()
  private readonly staleVisits = new Map<string, NativeVisit>()
  private readonly xpFlushes = new WeakMap<Session, Promise<void>>()
  private readonly pendingXp = new WeakMap<Session, PendingXp>()
  private settlementRetryMs = 5000
  private alarmAt: number | undefined

  /** Authenticated HTTP admission persists only a one-use seat, without a native room. */
  async reserveNative(lobbyId: string, accountId: string, protocol: number) {
    if (!(this.native?.running || (await this.directory().canLeaseRoom()).ok)) {
      return { refused: 'over_budget' as const }
    }
    const [profile, status, dyes] = await Promise.all([
      getProfile(this.env, accountId),
      standing(this.env, accountId),
      dyesOf(this.env, accountId),
    ])
    if (!profile) {
      throw new Error('Profile unavailable')
    }
    const reservation = this.seats.issue(this.ctx.id.toString(), {
      lobbyId,
      protocol,
      profile: {
        accountId,
        name: profile.name,
        level: profile.level,
        prestige: profile.prestige,
        loadout: Object.values(profile.loadout),
        banked: profile.purse,
        tcpRtt: null,
        ledger: true,
        saddlebag: bagStyleIndex(profile.loadout.saddlebag),
        frozen: isShadowed(status.flags),
        blocked: status.blocked,
        appearance: { loadout: profile.loadout, dyes },
      },
    })
    await this.scheduleSettlementRetry(false)
    return reservation
  }

  private nativeRoom(lobbyId: string): Promise<NativeFrontierRoom> {
    this.lobbyId = lobbyId
    this.core ??= new LobbyCore(lobbyId, crypto.getRandomValues(new Uint32Array(1))[0] ?? 1)
    const core = this.core
    this.nativeInitializing ??= createNativeRoom({
      id: this.ctx.id.toString(),
      core,
      onTick: (out) => {
        this.handle(out)
        this.afterNativeStep(core)
      },
      onStart: () => this.startNative(core),
      onJoin: (session) => this.onNativeJoin(core, session),
      onLeave: (session) => this.onDisconnect(core, session.playerId),
      onEmpty: () => this.stop(core, Date.now()),
      onControl: (session, text, gameNow) => {
        if (!this.voiceText(core, session.playerId, text)) {
          core.onText(session.playerId, text, gameNow, true)
        }
      },
    })
      .then(async (created) => {
        if (this.core !== core) {
          created.stopGameplay()
          await created.disconnect()
          throw new DOMException('Town was closed', 'AbortError')
        }
        this.native = created
        return created
      })
      .catch((error) => {
        if (this.core === core) {
          this.nativeInitializing = undefined
        }
        throw error
      })
    return this.nativeInitializing
  }

  private async onNativeJoin(core: LobbyCore, session: Session) {
    if (session.ledger) {
      await this.xpFlushes.get(session)
      if (this.pendingXp.has(session)) {
        const player = core.world.players[session.playerId]
        if (player) {
          await this.flushXp({ session, player }, null)
        }
        if (this.pendingXp.has(session)) {
          throw new Error('Session settlement is pending. Try reconnecting shortly.')
        }
      }
      const visit = { sessionId: session.sessionId, lobbyId: this.lobbyId }
      await sessionStartStatement(this.env, this.lobbyId, session).run()
      await this.ctx.storage.put(`visit:${session.sessionId}`, visit)
      if (this.core !== core || !session.peer || core.sessionOf(session.playerId) !== session) {
        const player = core.world.players[session.playerId]
        if (player) {
          await this.flushXp({ session, player }, Date.now())
        }
        this.staleVisits.set(visit.sessionId, visit)
        await this.closeNativeVisits([visit], Date.now())
        return
      }
      this.nativeVisits.set(session.sessionId, visit)
    }
    this.arrived.push(session.accountId)
    this.reportDirectory(true)
    this.peakHumans = Math.max(this.peakHumans, core.humans())
  }

  private async startNative(core: LobbyCore): Promise<void> {
    if (this.core !== core) {
      throw new DOMException('Town was closed', 'AbortError')
    }
    const id = crypto.randomUUID()
    this.nativeLeaseId = id
    const grant = await this.directory().leaseRoom(id, 0)
    if (this.core !== core || this.nativeLeaseId !== id) {
      if (grant.ok) {
        await this.directory().leaseRoom(id, 0, true)
      }
      throw new DOMException('Town was closed', 'AbortError')
    }
    if (!grant.ok) {
      this.nativeLeaseId = ''
      throw new NativeBudgetRefusal('Today’s free hosting allowance is exhausted')
    }
    this.occupiedSince = grant.observedAt
    this.armNativeLease(core)
  }

  override webSocketMessage(socket: WebSocket, message: ArrayBuffer | string) {
    const client = this.nativeClients.get(socket)
    if (!client) {
      socket.close(1012, 'The room restarted. Reconnect with a fresh ticket.')
      return
    }
    if (this.core) {
      this.core.metrics.msgsIn++
    }
    client.dispatch(message)
  }
  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    // A hibernatable socket must acknowledge the close frame. Otherwise browsers wait
    // for their close timeout before reconnecting, beyond the avatar's linger grace.
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason)
    this.nativeClients.get(socket)?.disconnected(code, reason)
    this.nativeClients.delete(socket)
  }
  override webSocketError(socket: WebSocket) {
    this.webSocketClose(socket, 1011, 'Connection unavailable')
  }

  private directory() {
    return this.env.LOBBY_DIR.get(this.env.LOBBY_DIR.idFromName(DIRECTORY))
  }
  private armNativeLease(core: LobbyCore) {
    clearTimeout(this.nativeLeaseTimer)
    this.nativeLeaseTimer = setTimeout(() => {
      if (this.core !== core) {
        return
      }
      this.nativeLeaseWatchdog = setTimeout(() => this.stop(core, Date.now()), 5000)
      this.ctx.waitUntil(this.renewNativeLease(core))
    }, 30_000)
  }
  private async renewNativeLease(core: LobbyCore) {
    const id = this.nativeLeaseId
    const messages = core.metrics.msgsIn - this.nativeLeaseMessages
    this.nativeLeaseMessages = core.metrics.msgsIn
    try {
      const grant = await this.directory().leaseRoom(id, messages, false, {
        lobbyId: this.lobbyId,
        humans: core.humans(),
        accounts: core.accounts(),
      })
      if (this.core !== core || this.nativeLeaseId !== id) {
        await this.directory().leaseRoom(id, 0, true)
        return
      }
      clearTimeout(this.nativeLeaseWatchdog)
      this.nativeLeaseWatchdog = undefined
      if (grant.ok) {
        this.armNativeLease(core)
      } else {
        core.notice('Today’s free hosting allowance is exhausted. Practice remains open.')
        this.stop(core, grant.observedAt)
      }
    } catch {
      if (this.core === core && this.nativeLeaseId === id) {
        this.stop(core, Date.now())
      }
    }
  }
  private afterNativeStep(core: LobbyCore) {
    const now = Date.now()
    this.voice.update()
    this.peakHumans = Math.max(this.peakHumans, core.humans())
    if (core.world.tick % 40 === 0) {
      void this.flushDeposits()
    }
    if (core.world.tick % 1200 === 0) {
      this.ctx.waitUntil(
        this.minute(core, now).then(async () => {
          const budget = await budgetState(this.env)
          if (this.core === core && !budget.frontierOpen) {
            core.notice('Town has reached today’s free hosting allowance. Practice is still open.')
            this.stop(core, Date.now())
          }
        }),
      )
    }
    this.reportDirectory(false)
  }

  private core: LobbyCore | null = null
  private lobbyId = ''
  private readonly pending = new Map<string, SettledDeposit>()
  /** Sessions whose aimbot flag has been written to `accounts.flags` already. */
  private readonly aimbotFlagged = new Set<string>()
  private flushing: boolean
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
  private readonly tickDurations: number[] = []
  private readonly voice: VoiceCoordinator

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.voice = new VoiceCoordinator({
      env,
      title: () => `frontier-${this.lobbyId || 'lobby'}`,
      peers: () =>
        (this.core?.world.players ?? []).flatMap((player) =>
          player
            ? [
                {
                  id: player.id,
                  name: player.name,
                  x: player.x,
                  z: player.z,
                  human: !player.bot,
                  connected: Boolean(this.core?.sessionOf(player.id)?.peer),
                  available: player.alive && player.showdown < 0,
                },
              ]
            : [],
        ),
      send: (id, message) => {
        const peer = this.core?.sessionOf(id)?.peer
        if (peer) {
          this.sendVoice(peer, message)
        }
      },
      save: (state) => ctx.storage.put('voice', state),
      reschedule: () => this.scheduleSettlementRetry(false),
      waitUntil: (work) => ctx.waitUntil(work),
    })
    this.seats = new NativeSeats(ctx.storage)
    this.flushing = false
    const restored = ctx.blockConcurrencyWhile(async () => {
      this.alarmAt = (await ctx.storage.getAlarm()) ?? undefined
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS pending_deposits (key TEXT PRIMARY KEY, data TEXT NOT NULL)',
      )
      for (const row of ctx.storage.sql.exec<{ key: string; data: string }>(
        'SELECT key,data FROM pending_deposits',
      )) {
        const deposit = JSON.parse(row.data) as SettledDeposit & { lobbyId: string }
        this.pending.set(row.key, deposit)
        this.lobbyId ||= deposit.lobbyId
      }
      const saved = await ctx.storage.list<SettledDeposit & { lobbyId: string }>({ prefix: 'dep:' })
      for (const [key, d] of saved) {
        this.pending.set(key.slice(4), d)
        this.lobbyId ||= d.lobbyId
      }
      await this.voice.restore(await ctx.storage.get<VoiceStorage>('voice'))
      return [...(await ctx.storage.list<NativeVisit>({ prefix: 'visit:' })).values()]
    })
    // Native worlds are transient; seats are durable. Close only this DO's recorded visits after a restart.
    ctx.waitUntil(
      restored.then((visits) => {
        for (const visit of visits) {
          this.staleVisits.set(visit.sessionId, visit)
        }
        return Promise.all([this.recoverPersistedState(), this.voice.retry()])
      }),
    )
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('X-Native-Room')) {
      const upgradeError = lobbyUpgradeError(request)
      if (upgradeError) {
        return upgradeError
      }
      if (request.headers.get('X-Native-Room') !== this.ctx.id.toString()) {
        return new Response('Room expired', { status: 409 })
      }
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        return new Response('Seat required', { status: 401 })
      }
      const seat = this.seats.consume(
        sessionId,
        request.headers.get('X-Account-Id') ?? '',
        request.headers.get('X-Lobby-Id') ?? '',
      )
      if (!seat || seat.lobbyId !== request.headers.get('X-Lobby-Id')) {
        return new Response('Seat expired or already consumed', { status: 409 })
      }
      await this.scheduleSettlementRetry(false)
      const native = await this.nativeRoom(seat.lobbyId)
      const core = this.core
      if (!core) {
        return new Response('Room expired', { status: 409 })
      }
      await reserveNativeRoom(native, seat.profile, seat.protocol, sessionId)
      const pair = new WebSocketPair()
      const server = pair[1]
      this.ctx.acceptWebSocket(server)
      const client = new CloudflareClient(sessionId, server, (bytes) => {
        core.metrics.bytesOut += bytes
        core.metrics.msgsOut++
      })
      this.nativeClients.set(server, client)
      this.ctx.waitUntil(
        connectClientToRoom(
          native,
          client,
          createAuthContext({ headers: request.headers }),
          {},
        ).catch((error: unknown) => {
          this.nativeClients.delete(server)
          server.close(4001, error instanceof Error ? error.message : 'Join failed')
        }),
      )
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.pathname === '/stats') {
      return Response.json(this.stats())
    }
    return new Response('The game has been updated. Refresh to reconnect.', { status: 410 })
  }

  /**
   * Flush at disconnect, not only when the 10 s linger ends: with no sockets left the runtime may
   * evict the object before the linger finishes, and stats or usage must not be lost with it.
   */
  private onDisconnect(core: LobbyCore, playerId: number): void {
    this.voice.drop(playerId)
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
      if (this.pending.has(key)) {
        continue
      }
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO pending_deposits(key,data) VALUES(?,?)',
        key,
        JSON.stringify({ ...d, lobbyId: this.lobbyId }),
      )
      const stored = this.ctx.storage.sql
        .exec<{ data: string }>('SELECT data FROM pending_deposits WHERE key=?', key)
        .toArray()[0]
      if (!stored) {
        throw new Error('Pending deposit was not recorded')
      }
      this.pending.set(key, JSON.parse(stored.data) as SettledDeposit)
      if (this.pending.size === 1) {
        // Begin the durable alarm write in this callback: Workers output gates hold outgoing
        // deposit state until storage commits, including if the process dies before its next tick.
        this.ctx.waitUntil(this.scheduleSettlementRetry())
      }
    }
    for (const ev of core?.world.events ?? []) {
      if (ev.type === 'kill') {
        this.killsSinceReport++
      }
    }
    for (const dep of out.departures) {
      this.departed.push(dep.session.accountId)
      const now = Date.now()
      const visit = this.nativeVisits.get(dep.session.sessionId)
      this.ctx.waitUntil(
        this.flushXp(dep, now).then(() => this.closeNativeVisits(visit ? [visit] : [], now)),
      )
    }
  }

  private stop(core: LobbyCore, now: number): void {
    if (this.core !== core) {
      return
    }
    this.core = null
    this.departed.push(...core.accounts())
    void this.flushDeposits()
    const visits = [...this.nativeVisits.values()]
    this.ctx.waitUntil(this.minute(core, now).then(() => this.closeNativeVisits(visits, now)))
    this.occupiedSince = 0
    this.reportDirectory(true)
    if (this.nativeLeaseId) {
      const id = this.nativeLeaseId
      this.nativeLeaseId = ''
      this.ctx.waitUntil(
        this.directory()
          .leaseRoom(id, Math.max(0, core.metrics.msgsIn - this.nativeLeaseMessages), true)
          .then(() => undefined),
      )
    }
    clearTimeout(this.nativeLeaseTimer)
    clearTimeout(this.nativeLeaseWatchdog)
    this.nativeLeaseTimer = undefined
    this.nativeLeaseWatchdog = undefined
    this.nativeLeaseMessages = 0
    const native = this.native
    this.native = undefined
    this.nativeInitializing = undefined
    if (native) {
      native.stopGameplay()
      this.ctx.waitUntil(native.disconnect().then(() => undefined))
    }
    this.ctx.waitUntil(this.voice.close())
  }

  /** Authenticated game controls carry preferences and short speaking leases, never media. */
  private voiceText(core: LobbyCore, playerId: number, text: string): boolean {
    if (core !== this.core || !text.includes('voice_')) {
      return false
    }
    try {
      return this.voice.handle(playerId, JSON.parse(text))
    } catch {
      return false
    }
  }

  // biome-ignore lint/style/useThisInClassMethods: a tiny send helper
  private sendVoice(peer: { send: (data: Uint8Array | string) => void }, msg: object): void {
    try {
      peer.send(JSON.stringify(msg))
    } catch {
      // the socket closed while the token was minted; the disconnect path removes the participant
    }
  }

  // --- Settlement -------------------------------------------------------------------------------

  private async closeNativeVisits(visits: readonly NativeVisit[], now: number) {
    if (visits.length === 0) {
      return
    }
    for (const visit of visits) {
      this.staleVisits.set(visit.sessionId, visit)
    }
    let failed = true
    try {
      await this.env.DB.batch(
        visits.map((visit) =>
          this.env.DB.prepare(
            'UPDATE ffa_sessions SET left_at=COALESCE(left_at,?) WHERE id=? AND lobby_id=?',
          ).bind(now, visit.sessionId, visit.lobbyId),
        ),
      )
      await this.ctx.storage.delete(visits.map((visit) => `visit:${visit.sessionId}`))
      for (const visit of visits) {
        this.nativeVisits.delete(visit.sessionId)
        this.staleVisits.delete(visit.sessionId)
      }
      failed = false
    } finally {
      await this.scheduleSettlementRetry(failed)
    }
  }

  private async scheduleSettlementRetry(advanceBackoff = false) {
    const settlement = this.pending.size > 0 || this.staleVisits.size > 0
    const seat = this.seats.nextExpiry()
    const voice = this.voice.nextRetry
    const hasWork = settlement || seat !== undefined || voice !== undefined
    const retry = settlement ? Date.now() + this.settlementRetryMs : Number.POSITIVE_INFINITY
    const next = hasWork
      ? Math.min(
          seat ?? Number.POSITIVE_INFINITY,
          retry,
          voice ?? Number.POSITIVE_INFINITY,
          this.alarmAt ?? Number.POSITIVE_INFINITY,
        )
      : Number.POSITIVE_INFINITY
    // Publish the deadline before the first await: concurrent seats cannot postpone economic recovery.
    this.alarmAt = Number.isFinite(next) ? next : undefined
    if (this.alarmAt === undefined) {
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(this.alarmAt)
    }
    if (!settlement) {
      this.settlementRetryMs = 5000
    } else if (advanceBackoff) {
      this.settlementRetryMs = Math.min(3_600_000, this.settlementRetryMs * 2)
    }
  }

  private async recoverPersistedState() {
    await this.flushDeposits()
    try {
      await this.closeNativeVisits([...this.staleVisits.values()], Date.now())
    } catch (error) {
      console.error('ffa visit recovery failed; will retry', error)
    }
  }

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
          this.ctx.storage.sql.exec('DELETE FROM pending_deposits WHERE key=?', key)
          await this.ctx.storage.delete(`dep:${key}`)
          this.pending.delete(key)
          this.core?.confirmDeposit(d, true)
        } catch (err) {
          console.error('ffa deposit failed; will retry', key, err)
          this.core?.confirmDeposit(d, false)
        }
      }
    } finally {
      this.flushing = false
      await this.scheduleSettlementRetry(this.pending.size > 0)
    }
  }

  override async alarm() {
    this.alarmAt = undefined
    this.seats.expire()
    await this.voice.retry()
    await this.recoverPersistedState()
    await this.scheduleSettlementRetry(false)
  }

  private flushXp(dep: Departure, leftAt: number | null): Promise<void> {
    const previous = this.xpFlushes.get(dep.session) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.flushXpNow(dep, leftAt))
    this.xpFlushes.set(dep.session, next)
    return next
  }

  private async flushXpNow(dep: Departure, leftAt: number | null): Promise<void> {
    const { session: s, player: p } = dep
    if (!s.ledger) {
      return
    }
    const previous = this.pendingXp.get(s)
    const pending = previous ?? {
      xp: Math.max(0, p.stats.xp - s.xpFlushed),
      flushIndex: s.xpFlushIndex,
      stats: { ...p.stats },
      flags: s.flags,
      flagNow: (s.flags & FLAG_AIMBOT) !== 0 && !this.aimbotFlagged.has(s.sessionId),
      leftAt,
    }
    const { statements, xp } = xpFlushStatements(this.env, {
      session: { ...s, flags: pending.flags, xpFlushed: pending.stats.xp - pending.xp },
      player: { ...p, stats: pending.stats },
      flushIndex: pending.flushIndex,
      leftAt: pending.leftAt,
    })
    // The aimbot heuristic (§3.7) flags the account (§8): it rides in the Badlands from its next
    // join. Written once per session, in the same batch as the stats that carry the evidence.
    const flagNow = pending.flagNow
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
    // A lost D1 acknowledgement must replay the original amount/key, never later earnings.
    this.pendingXp.set(s, pending)
    try {
      await this.env.DB.batch(statements)
      s.xpFlushed += xp
      if (xp > 0) {
        s.xpFlushIndex++
      }
      if (flagNow) {
        this.aimbotFlagged.add(s.sessionId)
      }
      this.pendingXp.delete(s)
      if (previous && (p.stats.xp > s.xpFlushed || previous.leftAt !== leftAt)) {
        await this.flushXpNow(dep, leftAt)
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
    const seconds = this.occupiedSince > 0 ? Math.max(0, (now - this.occupiedSince) / 1000) : 0
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
      running: Boolean(this.native && this.core?.connectedHumans()),
      humans: core?.humans() ?? 0,
      bodies: core ? core.world.players.filter(Boolean).length : 0,
      ticks: core?.metrics.ticks ?? 0,
      bytesOut: core?.metrics.bytesOut ?? 0,
      msgsIn: core?.metrics.msgsIn ?? 0,
      msgsOut: core?.metrics.msgsOut ?? 0,
      droppedIn: core?.metrics.droppedIn ?? 0,
      links: [...(core?.sessions.values() ?? [])].map((session) => ({
        playerId: session.playerId,
        rtt: [...session.rtt],
        tcpRtt: session.tcpRtt,
      })),
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
