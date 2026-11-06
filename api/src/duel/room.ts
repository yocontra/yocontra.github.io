// biome-ignore-all lint/style/noExcessiveLinesPerFile: voice lifecycle and the existing room/lobby flow live together
/**
 * DuelRoom: one Bounty Hunt duel (two humans, or a human and a ghost or Town Outlaw), plus its
 * rematches. Server-authoritative; the beat sheet lives in `room-flow.ts`.
 *
 * - Sockets use the WebSocket Hibernation API. During a live duel the 400 ms ping loop and beat
 *   timers keep the object awake; in the rematch window everything timed moves to a storage alarm
 *   and the object may hibernate (only the rest state is persisted).
 * - Settlement is one D1 batch per duel: match row, ledger (`match:<room>:<n>`), stats, ghost
 *   samples, pair stats and any royalty.
 * - Usage: active duel seconds are reported as `duel_seconds`.
 */
import { DurableObject } from 'cloudflare:workers'
import type {
  DuelMode,
  Poster,
  RoomClientMessage,
  RoomServerMessage,
  Settlement,
} from '../../../src/experiments/out-west/contract/duel.ts'
import { pairFactor } from '../../../src/experiments/out-west/data/progression.ts'
import { recordUsage } from '../budget.ts'
import type { Env } from '../env.ts'
import { rttStats } from '../judge.ts'
import { accountFlags, isShadowed } from '../moderation/flags.ts'
import { reviewTiming } from '../moderation/timing.ts'
import { PING_INTERVAL_MS, RTT_SAMPLES } from '../net/constants.ts'
import {
  addVoiceParticipant,
  createVoiceMeeting,
  refreshVoiceToken,
  removeVoiceParticipant,
} from '../voice/realtime.ts'
import { getProfile, isConstraintError } from './external.ts'
import { loadGhostTraits } from './ghost.ts'
import { type Pair, type PvpLink, rttCapped, type Seat } from './judge-pvp.ts'
import { type AiOpponent, type GhostTraits, ghostOpponent, townOutlaw } from './opponents.ts'
import { RoomFlow } from './room-flow.ts'
import type { FinishedDuel, RestState } from './room-types.ts'
import {
  BOOKED_LEVEL_REWARD,
  buildSettlement,
  FLAG_ROUGH_TRAIL,
  FLAG_RTT_CAPPED,
  type HumanSeat,
  pairHistory,
  reconcileLevelReward,
} from './settle.ts'
import { realClock } from './standoff.ts'
import { duelStats } from './stats.ts'

/** Nobody connected within this long: the room closes without a duel. */
const CONNECT_TIMEOUT_MS = 30_000
const ROUGH_JITTER_MS = 50

/** What the matchmaker hands a new room. */
export interface RoomInit {
  roomId: string
  mode: DuelMode
  /** Seat 0 and seat 1 account ids. Seat 1 is null in a ghost duel. */
  accounts: [string, string | null]
  posters: [Poster, Poster]
  /** The ghost (ownerId set) or Town Outlaw (ownerId null) in seat 1. */
  ghost: { ownerId: string | null; level: number; prestige: number; rating: number } | null
}

interface Stored {
  init: RoomInit
  traits: GhostTraits | null
  /** RealtimeKit voice, created lazily when a seat turns it on. */
  voice?: { meetingId: string; participants: [string | null, string | null] }
}

interface Attachment {
  seat: Seat
  accountId: string
}

function parse(data: string | ArrayBuffer): RoomClientMessage | null {
  if (typeof data !== 'string' || data.length > 1024) {
    return null
  }
  try {
    const value = JSON.parse(data) as unknown
    return typeof value === 'object' && value !== null && 'type' in value
      ? (value as RoomClientMessage)
      : null
  } catch {
    return null
  }
}

export class DuelRoom extends DurableObject<Env> {
  private stored: Stored | null = null
  private flow: RoomFlow | null = null
  private closed: boolean
  private readonly tcp: [number | null, number | null] = [null, null]
  private readonly rtt: [number[], number[]] = [[], []]
  private readonly pingSentAt = new Map<number, number>()
  private pingSeq = 0
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private startedOnce: boolean
  private readonly voiceBusy: [boolean, boolean] = [false, false]
  private readonly voiceAt: [number, number] = [0, 0]
  /** One voice request at a time: two seats can ask for the same lazily-created meeting. */
  private voiceChain: Promise<void> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.closed = false
    this.startedOnce = false
  }

  // --- RPC from the matchmaker -----------------------------------------------------------------

  async init(init: RoomInit): Promise<void> {
    const traits = init.ghost?.ownerId ? await loadGhostTraits(this.env, init.ghost.ownerId) : null
    this.stored = { init, traits }
    await this.ctx.storage.put('stored', this.stored)
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS)
  }

  // --- sockets ---------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const stored = await this.load()
    if (!stored || this.closed) {
      return new Response('This duel is over.', { status: 410 })
    }
    const seat: Seat = request.headers.get('X-Seat') === '1' ? 1 : 0
    const accountId = request.headers.get('X-Account-Id') ?? ''
    if (stored.init.accounts[seat] !== accountId) {
      return new Response('Not your duel.', { status: 403 })
    }
    const tcp = Number(request.headers.get('X-Tcp-Rtt'))
    this.tcp[seat] = Number.isFinite(tcp) && tcp > 0 ? tcp : null
    for (const old of this.ctx.getWebSockets(`seat:${seat}`)) {
      // A reconnect replaces the old socket.
      old.close(4000, 'Replaced by a new connection')
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, [`seat:${seat}`])
    server.serializeAttachment({ seat, accountId } satisfies Attachment)

    const flow = this.ensureFlow(stored)
    if (this.startedOnce) {
      sendRoomMessage(server, helloMessage(stored, seat, flow.rematch))
      flow.connect(seat)
    } else {
      // The first arrival starts the intro; `started` sends the hello.
      this.startedOnce = true
      flow.start(0)
      flow.connect(seat)
    }
    this.startPings()
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const stored = await this.load()
    const attachment = ws.deserializeAttachment() as Attachment | null
    const message = parse(data)
    if (!(stored && attachment && message)) {
      return
    }
    if (message.type === 'pong') {
      this.onPong(attachment.seat, message.n)
      return
    }
    if (message.type === 'voice_on' || message.type === 'voice_off') {
      await this.voiceMessage(stored, attachment.seat, message.type === 'voice_on')
      return
    }
    const flow = this.ensureFlow(stored)
    flow.message(attachment.seat, message)
    if (flow.beat !== 'result' && flow.beat !== 'closed') {
      this.startPings()
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropped(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropped(ws)
  }

  private async dropped(ws: WebSocket): Promise<void> {
    const stored = await this.load()
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!(stored && attachment)) {
      return
    }
    // A replaced socket closing is not a drop.
    const live = this.ctx.getWebSockets(`seat:${attachment.seat}`).filter((s) => s !== ws)
    if (live.length === 0) {
      this.ensureFlow(stored).disconnect(attachment.seat)
    }
  }

  override async alarm(): Promise<void> {
    const stored = await this.load()
    if (!stored) {
      return
    }
    const flow = this.ensureFlow(stored)
    if (flow.beat === 'result') {
      flow.rematchExpired()
    } else if (!this.startedOnce && flow.draw === 0) {
      this.finishRoom()
    }
  }

  // --- state -----------------------------------------------------------------------------------

  private async load(): Promise<Stored | null> {
    if (this.stored) {
      return this.stored
    }
    this.stored = (await this.ctx.storage.get<Stored>('stored')) ?? null
    this.closed = (await this.ctx.storage.get<boolean>('closed')) ?? false
    const rest = await this.ctx.storage.get<RestState>('rest')
    if (this.stored && rest && !this.closed) {
      // Woken from hibernation in the rematch window.
      const flow = this.ensureFlow(this.stored)
      const connected = ([0, 1] as const).map((s) => this.ctx.getWebSockets(`seat:${s}`).length > 0)
      flow.restore(rest, [connected[0] ?? false, connected[1] ?? false])
      this.startedOnce = true
    }
    return this.stored
  }

  private ensureFlow(stored: Stored): RoomFlow {
    if (this.flow) {
      return this.flow
    }
    this.flow = new RoomFlow({
      matchId: stored.init.roomId,
      ai: aiFor(stored),
      clock: realClock,
      io: {
        send: (seat, message) => {
          for (const ws of this.ctx.getWebSockets(`seat:${seat}`)) {
            sendRoomMessage(ws, message)
          }
        },
        link: (seat) => this.link(seat),
        settle: (duel) => this.settle(stored, duel),
        idle: (deadline) => this.idle(deadline),
        close: () => this.finishRoom(),
        requeue: (seat) => this.requeue(stored, seat),
        started: (rematch) => {
          for (const seat of [0, 1] as const) {
            for (const ws of this.ctx.getWebSockets(`seat:${seat}`)) {
              sendRoomMessage(ws, helloMessage(stored, seat, rematch))
            }
          }
          this.ctx.waitUntil(this.ctx.storage.delete('rest'))
          this.startPings()
        },
      },
    })
    return this.flow
  }

  // --- pings -----------------------------------------------------------------------------------

  private startPings(): void {
    if (this.pingTimer !== undefined) {
      return
    }
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
  }

  private stopPings(): void {
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private ping(): void {
    const n = ++this.pingSeq
    this.pingSentAt.set(n, Date.now())
    if (this.pingSentAt.size > RTT_SAMPLES * 4) {
      const oldest = this.pingSentAt.keys().next().value
      if (oldest !== undefined) {
        this.pingSentAt.delete(oldest)
      }
    }
    const message = JSON.stringify({ type: 'ping', n } satisfies RoomServerMessage)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message)
      } catch {
        // ignored
      }
    }
  }

  private onPong(seat: Seat, n: number): void {
    const sentAt = this.pingSentAt.get(n)
    if (sentAt === undefined) {
      return
    }
    const samples = this.rtt[seat]
    samples.push(Date.now() - sentAt)
    if (samples.length > RTT_SAMPLES) {
      samples.shift()
    }
  }

  private link(seat: Seat): PvpLink {
    return { ...rttStats(this.rtt[seat]), tcp: this.tcp[seat] }
  }

  // --- rematch window, close -------------------------------------------------------------------

  private idle(deadline: number): void {
    this.stopPings()
    const rest = this.flow?.rest()
    if (rest) {
      this.ctx.waitUntil(
        this.ctx.storage.put('rest', rest).then(() => this.ctx.storage.setAlarm(deadline)),
      )
    }
  }

  private finishRoom(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.stopPings()
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Duel over')
      } catch {
        // ignored
      }
    }
    const accounts = this.stored?.init.accounts.filter((a): a is string => a !== null) ?? []
    const voice = this.stored?.voice
    const voiceCleanup =
      voice === undefined
        ? []
        : voice.participants
            .filter((p): p is string => p !== null)
            .map((p) => removeVoiceParticipant(this.env, voice.meetingId, p).catch(() => undefined))
    this.ctx.waitUntil(
      Promise.all([
        this.ctx.storage.deleteAll().then(() => this.ctx.storage.put('closed', true)),
        this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('mm:global'))
          .release(accounts)
          .catch(() => undefined),
        ...voiceCleanup,
      ]),
    )
  }

  /** Mint or revoke this seat's RealtimeKit participant token. Never reaches the duel flow. */
  private voiceMessage(stored: Stored, seat: Seat, on: boolean): Promise<void> {
    const next = this.voiceChain.then(() => this.voiceMessageNow(stored, seat, on))
    this.voiceChain = next.catch(() => undefined)
    return next
  }

  private async voiceMessageNow(stored: Stored, seat: Seat, on: boolean): Promise<void> {
    if (on) {
      const now = Date.now()
      if (this.voiceBusy[seat] || this.voiceAt[seat] + 2000 > now) {
        return
      }
      this.voiceAt[seat] = now
    } else if (this.voiceBusy[seat]) {
      return
    }
    const sockets = this.ctx.getWebSockets(`seat:${seat}`)
    const socket = sockets.at(-1)
    if (!socket) {
      return
    }
    if (!on) {
      const voice = stored.voice
      const participant = voice?.participants[seat]
      if (voice && participant) {
        voice.participants[seat] = null
        await this.ctx.storage.put('stored', stored)
        await removeVoiceParticipant(this.env, voice.meetingId, participant).catch(() => undefined)
      }
      return
    }
    if (stored.init.mode !== 'pvp' || stored.init.accounts[seat === 0 ? 1 : 0] === null) {
      socket.send(JSON.stringify({ type: 'voice_error', message: 'Voice is for human duels.' }))
      return
    }
    this.voiceBusy[seat] = true
    try {
      if (!stored.voice) {
        stored.voice = {
          meetingId: await createVoiceMeeting(this.env, `bounty-${stored.init.roomId}`),
          participants: [null, null],
        }
      }
      const voice = stored.voice
      const existing = voice.participants[seat]
      let token: string
      if (existing) {
        token = await refreshVoiceToken(this.env, voice.meetingId, existing)
      } else {
        const added = await addVoiceParticipant(
          this.env,
          voice.meetingId,
          stored.init.posters[seat].name,
          String(seat),
        )
        voice.participants[seat] = added.id
        token = added.token
      }
      await this.ctx.storage.put('stored', stored)
      socket.send(JSON.stringify({ type: 'voice_ready', meetingId: voice.meetingId, token }))
    } catch (err) {
      console.error('duel voice token failed', err)
      socket.send(JSON.stringify({ type: 'voice_error', message: 'Voice is unavailable.' }))
    } finally {
      this.voiceBusy[seat] = false
    }
  }

  private requeue(stored: Stored, seat: Seat): void {
    const accountId = stored.init.accounts[seat]
    if (accountId) {
      this.ctx.waitUntil(
        this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('mm:global'))
          .prioritize(accountId)
          .catch(() => undefined),
      )
    }
  }

  // --- settlement ------------------------------------------------------------------------------

  private async human(accountId: string | null): Promise<HumanSeat | null> {
    if (!accountId) {
      return null
    }
    const [profile, stats, flags] = await Promise.all([
      getProfile(this.env, accountId),
      duelStats(this.env, accountId),
      accountFlags(this.env, accountId),
    ])
    return profile ? { accountId, profile, stats, frozen: isShadowed(flags) } : null
  }

  private async settle(stored: Stored, duel: FinishedDuel): Promise<Pair<Settlement | null>> {
    const { init } = stored
    const matchId = `${init.roomId}:${duel.rematch}`
    const now = Date.now()
    this.ctx.waitUntil(
      recordUsage(this.env, 'duel_seconds', (duel.endedAt - duel.startedAt) / 1000).catch(
        () => undefined,
      ),
    )
    const [a, b] = await Promise.all([this.human(init.accounts[0]), this.human(init.accounts[1])])
    if (!a || (init.mode === 'pvp' && !b)) {
      return [null, null]
    }
    const pair =
      init.mode === 'pvp' && b
        ? await pairHistory(this.env, a.accountId, b.accountId, now)
        : { recent: [], matchNumber: 1 }
    const royaltiesToday = init.ghost?.ownerId ? await this.royaltiesToday(init.ghost.ownerId) : 0
    const links = [this.link(0), this.link(1)] as const
    const humanSeats: Seat[] = init.mode === 'pvp' ? [0, 1] : [0]
    let flags = 0
    for (const s of humanSeats) {
      if (rttCapped(links[s])) {
        flags |= FLAG_RTT_CAPPED
      }
      if (links[s].jitter > ROUGH_JITTER_MS) {
        flags |= FLAG_ROUGH_TRAIL
      }
    }
    const { statements, settlements } = buildSettlement(this.env, {
      matchId,
      rematch: duel.rematch,
      mode: init.mode,
      outcome: duel.outcome,
      winner: duel.winner,
      culprit: duel.culprit,
      reactions: duel.reactions,
      deadHeats: duel.deadHeats,
      humans: [a, init.mode === 'pvp' ? b : null],
      ghost: init.ghost ? { ...init.ghost, royaltiesToday } : null,
      wait: duel.wait,
      rtts: [links[0].median, init.mode === 'pvp' ? links[1].median : null],
      flags,
      pairMatchNumber: pair.matchNumber,
      pairFactor: init.mode === 'pvp' ? pairFactor(pair.matchNumber) : 1,
      pairRecent: pair.recent,
      startedAt: duel.startedAt,
      now,
    })
    try {
      await this.env.DB.batch(statements)
    } catch (err) {
      // A retried settlement collides on the match row: it already committed.
      const done = await this.env.DB.prepare('SELECT 1 AS done FROM matches WHERE id = ?')
        .bind(matchId)
        .first<{ done: number }>()
      if (!done) {
        console.error('settlement failed', isConstraintError(err), err)
        throw err
      }
    }
    // The §8 timing statistics, on the reactions this duel just added: a tripped tell sends the
    // account to the Badlands. Out of band, so it never delays the result.
    for (const h of [a, b]) {
      if (h && duel.outcome !== 'dodge') {
        this.ctx.waitUntil(reviewTiming(this.env, h.accountId).then(() => undefined))
      }
    }
    // Level-up rewards are applied inside the ledger, so read the purses and rewards back.
    return [
      await this.committed(settlements[0], a.accountId, matchId),
      await this.committed(settlements[1], b?.accountId ?? null, matchId),
    ]
  }

  /** A seat's settlement as committed: its purse now and the level reward actually booked. */
  private async committed(
    s: Settlement | null,
    accountId: string | null,
    matchId: string,
  ): Promise<Settlement | null> {
    if (!(s && accountId)) {
      return s
    }
    const [profile, booked] = await Promise.all([
      getProfile(this.env, accountId),
      this.env.DB.prepare(BOOKED_LEVEL_REWARD)
        .bind(accountId, `match:${matchId}#`)
        .first<{ reward: number }>(),
    ])
    const settled = reconcileLevelReward(s, booked?.reward ?? 0)
    return { ...settled, purse: profile?.purse ?? settled.purse }
  }

  private async royaltiesToday(ownerId: string): Promise<number> {
    const row = await this.env.DB.prepare(
      'SELECT royalties_today, royalties_day FROM ghost_profiles WHERE account_id = ?',
    )
      .bind(ownerId)
      .first<{ royalties_today: number; royalties_day: string | null }>()
    return row?.royalties_day === new Date().toISOString().slice(0, 10) ? row.royalties_today : 0
  }
}

function helloMessage(stored: Stored, seat: Seat, rematch: number): RoomServerMessage {
  return {
    type: 'hello',
    serverTime: Date.now(),
    matchId: stored.init.roomId,
    mode: stored.init.mode,
    you: seat,
    posters: stored.init.posters,
    rematch,
  }
}

function aiFor(stored: Stored): (() => AiOpponent) | null {
  const ghost = stored.init.ghost
  if (stored.init.mode !== 'ghost' || !ghost) {
    return null
  }
  const traits = stored.traits
  return traits && traits.reactions.length > 0
    ? () => ghostOpponent(traits)
    : () => townOutlaw(ghost.rating)
}

function sendRoomMessage(ws: WebSocket, message: RoomServerMessage): void {
  try {
    ws.send(JSON.stringify(message))
  } catch {
    // The close handler deals with dead sockets.
  }
}
