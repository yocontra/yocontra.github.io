/**
 * Bounty Hunt queue: brackets widen over time, ghost fallback at 18 s. Owned by stream B.
 *
 * One object, `mm:global`. At our scale a single queue is the right shard: it ticks once a second
 * and only while someone waits, and splitting it would only shrink the pool. If it ever needs to
 * shard, key it by `request.cf.continent` (`mm:amer`, `mm:emea`, `mm:apac`) like the Frontier
 * directory; nothing else changes.
 *
 * Sockets use the Hibernation API. Each queue entry lives in its socket's attachment, the tick is a
 * 1 Hz storage alarm while the queue is non-empty, and an empty queue costs nothing.
 */
import { DurableObject } from 'cloudflare:workers'
import type {
  Poster,
  QueueClientMessage,
  QueueRefusal,
  QueueServerMessage,
} from '../../../src/experiments/out-west/contract/duel.ts'
import {
  DEFAULT_LOADOUT,
  type Loadout,
  normalizeLoadout,
} from '../../../src/experiments/out-west/data/catalog.ts'
import type { Dyes } from '../../../src/experiments/out-west/data/dye.ts'
import { licenceStatus } from '../../../src/experiments/out-west/data/licence.ts'
import {
  baseBounty,
  bountyForLevel,
  effectiveLevel,
} from '../../../src/experiments/out-west/data/progression.ts'
import { budgetState } from '../budget.ts'
import { dyesOf } from '../economy/sinks.ts'
import type { Env } from '../env.ts'
import { rttStats } from '../judge.ts'
import { isShadowed, standing } from '../moderation/flags.ts'
import { DODGE_WINDOW_MS } from '../net/constants.ts'
import { getProfileDetail } from './external.ts'
import { eligibleGhosts, type GhostCandidate } from './ghost.ts'
import { linkOkForPvp } from './judge-pvp.ts'
import { ghostButton, pickGhost, planTick, type QueueEntry, windowFor } from './queue.ts'
import type { RoomInit } from './room.ts'
import { duelStats } from './stats.ts'
import { roomToken } from './token.ts'

/** The dyes on the items he wears (the poster rides a 2 KB socket attachment: nothing else). */
function wornDyes(loadout: Loadout, dyes: Dyes): Dyes {
  const worn = new Set<string>(Object.values(loadout))
  return Object.fromEntries(Object.entries(dyes).filter(([id]) => worn.has(id))) as Dyes
}

const TICK_MS = 1000
const GHOST_INDEX_TTL_MS = 5 * 60 * 1000
/**
 * A safety net if a room never releases its players. Six duels with 20 s rematch windows can run
 * about four minutes, so this sits above that.
 */
const IN_ROOM_TTL_MS = 6 * 60 * 1000
const PRIORITY_TTL_MS = 60 * 1000
const DODGE_LIMIT = 3
const DODGE_COOLDOWN_MS = 5 * 60 * 1000
/** Ping samples needed before a link is judged. */
const MIN_PING_SAMPLES = 3
const RTT_KEEP = 8

interface Attachment {
  entry: QueueEntry
  poster: Poster
  tcp: number | null
  rtt: number[]
  pingN: number
  pingAt: number
  wsBase: string
}

/** Stored block lists for these accounts (storage reads take at most 128 keys at a time). */
async function blockLists(
  storage: DurableObjectStorage,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const keys = ids.map((id) => `blocked:${id}`)
  const chunks: string[][] = []
  for (let i = 0; i < keys.length; i += 128) {
    chunks.push(keys.slice(i, i + 128))
  }
  const maps = await Promise.all(chunks.map((c) => storage.get<string[]>(c)))
  return new Map(maps.flatMap((m) => [...m]))
}

export class Matchmaker extends DurableObject<Env> {
  private ghosts: { at: number; list: GhostCandidate[] } | null = null
  /** Networks of recently queued accounts (memory only, never persisted), for ghost selection. */
  private readonly netOf = new Map<string, QueueEntry['net']>()
  /** Block lists of the accounts waiting, read from storage on every tick. */
  private blocks = new Map<string, string[]>()

  /** The entry with its stored block list. */
  private withBlocks(e: QueueEntry): QueueEntry {
    const list = this.blocks.get(`blocked:${e.accountId}`)
    return list ? { ...e, blocked: list } : e
  }

  // --- RPC from rooms --------------------------------------------------------------------------

  /** The room closed: these players may queue again. */
  async release(accountIds: readonly string[]): Promise<void> {
    await this.ctx.storage.delete(accountIds.map((id) => `room:${id}`))
  }

  /** A dodged player: their next queue within a minute goes to the front. */
  async prioritize(accountId: string): Promise<void> {
    await this.ctx.storage.delete(`room:${accountId}`)
    await this.ctx.storage.put(`priority:${accountId}`, Date.now() + PRIORITY_TTL_MS)
  }

  // --- joining ---------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    // Tagged by account so a second tab or device is refused.
    this.ctx.acceptWebSocket(server, [request.headers.get('X-Account-Id') ?? 'anonymous'])
    const refusal = await this.admit(request, server)
    if (refusal) {
      sendQueueMessage(server, { type: 'refused', ...refusal })
      server.close(1000, refusal.reason)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  private async admit(
    request: Request,
    ws: WebSocket,
  ): Promise<{ reason: QueueRefusal; message: string; retryAfterS?: number } | null> {
    const accountId = request.headers.get('X-Account-Id') ?? ''
    if (!accountId) {
      return { reason: 'unauthorized', message: 'Sign in to play Bounty Hunt.' }
    }
    const budget = await budgetState(this.env)
    if (!budget.duelsOpen) {
      return {
        reason: 'budget',
        message: 'Bounty Hunt is closed until the next daily reset (00:00 UTC).',
      }
    }
    const busyUntil = await this.ctx.storage.get<number>(`room:${accountId}`)
    const queued = this.ctx.getWebSockets(accountId).length > 1
    if (queued || (busyUntil !== undefined && busyUntil > Date.now())) {
      return { reason: 'busy', message: "You're already in the queue or a duel." }
    }
    const [profile, stats, standingNow, dyes] = await Promise.all([
      getProfileDetail(this.env, accountId),
      duelStats(this.env, accountId),
      standing(this.env, accountId),
      dyesOf(this.env, accountId),
    ])
    if (!profile) {
      return { reason: 'no-profile', message: 'Sign up first.' }
    }
    if (!licenceStatus(profile.gauntletClears).licensed) {
      return {
        reason: 'unlicensed',
        message: 'You need a licence. Beat 3 outlaws on a ranked run.',
      }
    }
    const now = Date.now()
    const dodges = stats.dodges.filter((t) => t > now - DODGE_WINDOW_MS)
    const lastDodge = Math.max(0, ...dodges)
    if (dodges.length >= DODGE_LIMIT && lastDodge + DODGE_COOLDOWN_MS > now) {
      const retryAfterS = Math.ceil((lastDodge + DODGE_COOLDOWN_MS - now) / 1000)
      return {
        reason: 'cooldown',
        message: 'You dodged too many duels. Wait a while, then try again.',
        retryAfterS,
      }
    }
    const history = await this.history(accountId)
    const priorityUntil = await this.ctx.storage.get<number>(`priority:${accountId}`)
    const net = networkOf(request)
    this.netOf.set(accountId, net)
    const tcp = Number(request.headers.get('X-Tcp-Rtt'))
    const entry: QueueEntry = {
      accountId,
      joinedAt: now,
      priority: priorityUntil !== undefined && priorityUntil > now,
      effectiveLevel: effectiveLevel(profile.level, profile.prestige),
      rating: stats.drawRating,
      net,
      ghostsOnly: false,
      wantsGhost: false,
      lastOpponents: history.opponents,
      recentGhosts: history.ghosts,
      ...(isShadowed(standingNow.flags) ? { badlands: true } : {}),
    }
    // Block lists can outgrow a socket attachment (2 KB), so they live in storage by account.
    if (standingNow.blocked.length > 0) {
      await this.ctx.storage.put(`blocked:${accountId}`, standingNow.blocked)
    } else {
      await this.ctx.storage.delete(`blocked:${accountId}`)
    }
    const poster: Poster = {
      name: profile.name,
      level: profile.level,
      prestige: profile.prestige,
      bounty: bountyForLevel(profile.level, stats.streak, profile.prestige),
      streak: stats.streak,
      cowardice: stats.cowardice,
      loadout: profile.loadout,
      dyes: wornDyes(profile.loadout, dyes),
      kind: 'human',
    }
    ws.serializeAttachment({
      entry,
      poster,
      tcp: Number.isFinite(tcp) && tcp > 0 ? tcp : null,
      rtt: [],
      pingN: 0,
      pingAt: 0,
      wsBase: request.headers.get('X-Ws-Base') ?? '',
    } satisfies Attachment)
    sendQueueMessage(ws, {
      type: 'queued',
      serverTime: now,
      effectiveLevel: entry.effectiveLevel,
      ghostsOnly: false,
    })
    await this.ensureAlarm()
    return null
  }

  private async history(accountId: string): Promise<{ opponents: string[]; ghosts: string[] }> {
    const [opponents, ghosts] = await this.env.DB.batch([
      this.env.DB.prepare(
        `SELECT CASE WHEN a_id = ?1 THEN b_id ELSE a_id END AS other FROM matches
         WHERE mode = 'pvp' AND rematch = 0 AND (a_id = ?1 OR b_id = ?1)
         ORDER BY ended_at DESC LIMIT 2`,
      ).bind(accountId),
      this.env.DB.prepare(
        `SELECT ghost_of AS other FROM matches WHERE mode = 'ghost' AND a_id = ?1 AND ghost_of IS NOT NULL
         ORDER BY ended_at DESC LIMIT 10`,
      ).bind(accountId),
    ])
    const ids = (r: D1Result | undefined) =>
      ((r?.results ?? []) as { other: string | null }[])
        .map((row) => row.other)
        .filter((id): id is string => id !== null)
    return { opponents: ids(opponents), ghosts: ids(ghosts) }
  }

  // --- socket events ---------------------------------------------------------------------------

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    const att = ws.deserializeAttachment() as Attachment | null
    if (!att || typeof data !== 'string' || data.length > 256) {
      return
    }
    let message: QueueClientMessage
    try {
      message = JSON.parse(data) as QueueClientMessage
    } catch {
      return
    }
    if (message.type === 'pong' && message.n === att.pingN && att.pingAt > 0) {
      att.rtt = [...att.rtt, Date.now() - att.pingAt].slice(-RTT_KEEP)
      att.pingAt = 0
      ws.serializeAttachment(att)
    } else if (message.type === 'ghost' && ghostButton(Date.now() - att.entry.joinedAt)) {
      att.entry = { ...att.entry, wantsGhost: true }
      ws.serializeAttachment(att)
    } else if (message.type === 'leave') {
      ws.close(1000, 'Left the queue')
    }
  }

  override webSocketClose(ws: WebSocket): void {
    ws.serializeAttachment(null)
  }

  // --- the tick --------------------------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
    }
  }

  private waiting(): Map<string, { ws: WebSocket; att: Attachment }> {
    const map = new Map<string, { ws: WebSocket; att: Attachment }>()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att && ws.readyState === WebSocket.OPEN) {
        map.set(att.entry.accountId, { ws, att })
      }
    }
    return map
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    const waiting = this.waiting()
    if (waiting.size === 0) {
      return
    }
    for (const { att } of waiting.values()) {
      const link = { ...rttStats(att.rtt), tcp: att.tcp }
      const ghostsOnly = att.rtt.length >= MIN_PING_SAMPLES && !linkOkForPvp(link)
      att.entry = { ...att.entry, ghostsOnly }
    }
    this.blocks = await blockLists(this.ctx.storage, [...waiting.keys()])
    const actions = planTick(
      [...waiting.values()].map((w) => this.withBlocks(w.att.entry)),
      now,
    )
    for (const action of actions) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: rooms are created one at a time, in queue order
        await (action.kind === 'pair'
          ? this.pairUp(waiting, action.a, action.b)
          : this.ghostDuel(waiting, action.a))
      } catch (err) {
        console.error('matchmaking failed', err)
      }
      waiting.delete(action.a)
      if (action.kind === 'pair') {
        waiting.delete(action.b)
      }
    }
    for (const { ws, att } of waiting.values()) {
      const waited = now - att.entry.joinedAt
      const window = windowFor(waited)
      sendQueueMessage(ws, {
        type: 'status',
        serverTime: now,
        waitedMs: waited,
        waiting: waiting.size,
        levelWindow: window.level,
        ratingWindow: window.rating,
        ghostButton: ghostButton(waited),
        ghostsOnly: att.entry.ghostsOnly,
      })
      att.pingN++
      att.pingAt = Date.now()
      ws.serializeAttachment(att)
      sendQueueMessage(ws, { type: 'ping', n: att.pingN })
    }
    if (waiting.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
    }
  }

  // --- making rooms ----------------------------------------------------------------------------

  private async openRoom(init: RoomInit): Promise<void> {
    const stub = this.env.DUEL_ROOMS.get(this.env.DUEL_ROOMS.idFromName(init.roomId))
    await stub.init(init)
    const until = Date.now() + IN_ROOM_TTL_MS
    for (const id of init.accounts) {
      if (id) {
        // biome-ignore lint/performance/noAwaitInLoops: at most two writes
        await this.ctx.storage.put(`room:${id}`, until)
        await this.ctx.storage.delete(`priority:${id}`)
      }
    }
  }

  private async matched(
    w: { ws: WebSocket; att: Attachment },
    init: RoomInit,
    seat: 0 | 1,
  ): Promise<void> {
    const token = await roomToken(this.env, init.roomId, w.att.entry.accountId, seat)
    const opponent = init.posters[seat === 0 ? 1 : 0]
    sendQueueMessage(w.ws, {
      type: 'matched',
      matchId: init.roomId,
      mode: init.mode,
      wsUrl: `${w.att.wsBase}/duel/${init.roomId}/ws?token=${encodeURIComponent(token)}`,
      opponent,
    })
    w.ws.serializeAttachment(null)
    w.ws.close(1000, 'Matched')
  }

  private async pairUp(
    waiting: Map<string, { ws: WebSocket; att: Attachment }>,
    a: string,
    b: string,
  ): Promise<void> {
    const wa = waiting.get(a)
    const wb = waiting.get(b)
    if (!(wa && wb)) {
      return
    }
    const init: RoomInit = {
      roomId: crypto.randomUUID().replaceAll('-', ''),
      mode: 'pvp',
      accounts: [a, b],
      posters: [wa.att.poster, wb.att.poster],
      ghost: null,
    }
    await this.openRoom(init)
    await Promise.all([this.matched(wa, init, 0), this.matched(wb, init, 1)])
  }

  private async ghostIndex(): Promise<GhostCandidate[]> {
    if (!this.ghosts || Date.now() - this.ghosts.at > GHOST_INDEX_TTL_MS) {
      this.ghosts = { at: Date.now(), list: await eligibleGhosts(this.env) }
    }
    return this.ghosts.list
  }

  private async ghostDuel(
    waiting: Map<string, { ws: WebSocket; att: Attachment }>,
    a: string,
  ): Promise<void> {
    const w = waiting.get(a)
    if (!w) {
      return
    }
    const entry = this.withBlocks(w.att.entry)
    const ghost = pickGhost(entry, await this.ghostIndex(), (id) => this.netOf.get(id) ?? null)
    const level = Math.max(1, Math.min(50, entry.effectiveLevel))
    const poster: Poster = ghost
      ? {
          name: ghost.name,
          level: ghost.level,
          prestige: ghost.prestige,
          bounty: baseBounty(ghost.level, ghost.prestige),
          streak: 0,
          cowardice: 0,
          loadout: normalizeLoadout(ghost.loadout),
          dyes: wornDyes(normalizeLoadout(ghost.loadout), await dyesOf(this.env, ghost.accountId)),
          kind: 'ghost',
        }
      : {
          name: 'Town Outlaw',
          level,
          prestige: 0,
          bounty: baseBounty(level),
          streak: 0,
          cowardice: 0,
          loadout: { ...DEFAULT_LOADOUT },
          kind: 'outlaw',
        }
    const init: RoomInit = {
      roomId: crypto.randomUUID().replaceAll('-', ''),
      mode: 'ghost',
      accounts: [a, null],
      posters: [w.att.poster, poster],
      ghost: ghost
        ? {
            ownerId: ghost.accountId,
            level: ghost.level,
            prestige: ghost.prestige,
            rating: ghost.drawRating,
          }
        : { ownerId: null, level, prestige: 0, rating: entry.rating },
    }
    await this.openRoom(init)
    await this.matched(w, init, 0)
  }
}

function networkOf(request: Request): QueueEntry['net'] {
  const ip = request.headers.get('X-Ip-Hash')
  const prefix = request.headers.get('X-Prefix-Hash')
  return ip && prefix ? { ip, prefix } : null
}

function sendQueueMessage(ws: WebSocket, message: QueueServerMessage): void {
  try {
    ws.send(JSON.stringify(message))
  } catch {
    // Closed sockets are dropped on the next tick.
  }
}
