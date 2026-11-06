/**
 * Bounty Hunt: queueing, matchmaking and duel room WebSockets. Owned by stream B.
 *   POST /queue/ticket        { turnstileToken } (Bearer) → { ticket, wsUrl }
 *   GET  /queue/ws?ticket=    WebSocket into the Matchmaker
 *   GET  /duel/:id/ws?token=  WebSocket into that match's DuelRoom (reusable token)
 *   GET  /duel/:id            (Bearer) the latest committed result of that room, for either player
 *   GET  /duel/settings       (Bearer) → { ghostOptOut }
 *   PUT  /duel/settings       (Bearer) { ghostOptOut } → { ghostOptOut }: "Let my ghost ride"
 *   GET  /duel/stats          (Bearer) → public Bounty Hunt standing
 */
import type {
  DuelSettings,
  DuelStatsResponse,
  MatchSummary,
  QueueTicketResponse,
} from '../../../src/experiments/out-west/contract/duel.ts'
import { authenticate, issueTicket, redeemTicket } from '../duel/external.ts'
import { duelStats, setGhostOptOutStatements } from '../duel/stats.ts'
import { verifyRoomToken } from '../duel/token.ts'
import type { Env } from '../env.ts'
import {
  allowedOrigin,
  BODY_STANDARD,
  BODY_TINY,
  error,
  json,
  type RouteHandler,
  readObject,
  verifyTurnstile,
} from '../http.ts'

const ROOM_WS = /^\/duel\/(?<id>[0-9a-f]{32})\/ws$/u
const ROOM = /^\/duel\/(?<id>[0-9a-f]{32})$/u
const INTERNAL_HEADERS = [
  'X-Account-Id',
  'X-Seat',
  'X-Tcp-Rtt',
  'X-Ip-Hash',
  'X-Prefix-Hash',
  'X-Ws-Base',
]
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Cloudflare's transport RTT at the upgrade (TCP, or QUIC for HTTP/3). */
function transportRtt(request: Request): number | null {
  const cf = request.cf as { clientTcpRtt?: unknown; clientQuicRtt?: unknown } | undefined
  const rtt = cf?.clientTcpRtt ?? cf?.clientQuicRtt
  return typeof rtt === 'number' && rtt > 0 ? rtt : null
}

/**
 * The client's IP. Production always has a real CF-Connecting-IP. Local dev has none or a loopback
 * one, so a dev-only `X-Dev-Ip` lets the harness simulate networks; without it, the rules are skipped.
 */
function clientIp(request: Request, env: Env): string | null {
  const ip = request.headers.get('CF-Connecting-IP')
  const local = ip === null || LOOPBACK.has(ip)
  if (!local) {
    return ip
  }
  return env.RP_ID === 'localhost' ? request.headers.get('X-Dev-Ip') : null
}

async function hash(text: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${text}|${day}`))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Hashes of the IP and of its /24 (IPv4) or /48 (IPv6). Raw IPs are never stored. */
async function networkHeaders(request: Request, env: Env, headers: Headers): Promise<void> {
  const ip = clientIp(request, env)
  if (!ip) {
    return
  }
  const prefix = IPV4.test(ip)
    ? ip.split('.').slice(0, 3).join('.')
    : ip.toLowerCase().split(':').slice(0, 3).join(':')
  headers.set('X-Ip-Hash', await hash(`ip|${ip}`))
  headers.set('X-Prefix-Hash', await hash(`prefix|${prefix}`))
}

function internal(request: Request): Headers {
  const headers = new Headers(request.headers)
  for (const name of INTERNAL_HEADERS) {
    headers.delete(name)
  }
  return headers
}

function wsBase(url: URL): string {
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
}

async function queueTicket(request: Request, env: Env, url: URL): Promise<Response> {
  if (!allowedOrigin(request, env)) {
    return error(request, env, 403, 'Origin not allowed.')
  }
  const player = await authenticate(request, env)
  if (!player) {
    return error(request, env, 401, 'Sign in to play Bounty Hunt.')
  }
  const body = await readObject(request, BODY_STANDARD)
  const token = body.turnstileToken
  if (typeof token !== 'string' || !(await verifyTurnstile(token, request, env))) {
    return error(request, env, 403, 'Couldn’t verify this device. Try again.')
  }
  const ticket = await issueTicket(env, player, 'duel')
  const body2: QueueTicketResponse = {
    ticket,
    wsUrl: `${wsBase(url)}/queue/ws?ticket=${encodeURIComponent(ticket)}`,
  }
  return json(request, env, body2, 201)
}

async function queueSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  if (!allowedOrigin(request, env)) {
    return new Response('Origin not allowed', { status: 403 })
  }
  const player = await redeemTicket(env, url.searchParams.get('ticket') ?? '', 'duel')
  if (!player) {
    return new Response('Unknown or expired ticket', { status: 401 })
  }
  const headers = internal(request)
  headers.set('X-Account-Id', player.accountId)
  headers.set('X-Ws-Base', wsBase(url))
  const tcp = transportRtt(request)
  if (tcp !== null) {
    headers.set('X-Tcp-Rtt', String(tcp))
  }
  await networkHeaders(request, env, headers)
  const stub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:global'))
  return stub.fetch(new Request(request, { headers }))
}

async function roomSocket(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  if (!allowedOrigin(request, env)) {
    return new Response('Origin not allowed', { status: 403 })
  }
  const verified = await verifyRoomToken(env, id, url.searchParams.get('token') ?? '')
  if (!verified) {
    return new Response('Bad room token', { status: 401 })
  }
  const headers = internal(request)
  headers.set('X-Account-Id', verified.accountId)
  headers.set('X-Seat', String(verified.seat))
  const tcp = transportRtt(request)
  if (tcp !== null) {
    headers.set('X-Tcp-Rtt', String(tcp))
  }
  const stub = env.DUEL_ROOMS.get(env.DUEL_ROOMS.idFromName(id))
  return stub.fetch(new Request(request, { headers }))
}

async function summary(request: Request, env: Env, id: string): Promise<Response> {
  const player = await authenticate(request, env)
  if (!player) {
    return error(request, env, 401, 'Sign in first.')
  }
  const row = await env.DB.prepare(
    `SELECT id, mode, outcome FROM matches WHERE id LIKE ?1 || ':%' AND (a_id = ?2 OR b_id = ?2)
     ORDER BY rematch DESC LIMIT 1`,
  )
    .bind(id, player.accountId)
    .first<{ id: string; mode: 'pvp' | 'ghost'; outcome: MatchSummary['outcome'] }>()
  const body: MatchSummary = {
    matchId: id,
    mode: row?.mode ?? 'pvp',
    outcome: row?.outcome ?? null,
    settled: row !== null,
  }
  return json(request, env, body)
}

async function settings(request: Request, env: Env): Promise<Response> {
  const player = await authenticate(request, env)
  if (!player) {
    return error(request, env, 401, 'Sign in first.')
  }
  if (request.method === 'PUT') {
    const body = await readObject(request, BODY_TINY)
    if (typeof body.ghostOptOut !== 'boolean') {
      return error(request, env, 400, 'Expected { ghostOptOut: boolean }.')
    }
    await env.DB.batch(setGhostOptOutStatements(env, player.accountId, body.ghostOptOut))
  }
  const row = await env.DB.prepare('SELECT opt_out FROM ghost_profiles WHERE account_id = ?')
    .bind(player.accountId)
    .first<{ opt_out: number }>()
  const out: DuelSettings = { ghostOptOut: row?.opt_out === 1 }
  return json(request, env, out)
}

async function stats(request: Request, env: Env): Promise<Response> {
  const player = await authenticate(request, env)
  if (!player) {
    return error(request, env, 401, 'Sign in first.')
  }
  const s = await duelStats(env, player.accountId)
  const out: DuelStatsResponse = {
    streak: s.streak,
    bestStreak: s.bestStreak,
    wins: s.wins,
    losses: s.losses,
    draws: s.draws,
    cowardice: s.cowardice,
  }
  return json(request, env, out)
}

export const duelRoutes: RouteHandler = async (request, env, url) => {
  const { pathname } = url
  const method = request.method
  if (pathname === '/queue/ticket' && method === 'POST') {
    return await queueTicket(request, env, url)
  }
  if (pathname === '/queue/ws' && method === 'GET') {
    return await queueSocket(request, env, url)
  }
  if (pathname === '/duel/settings' && (method === 'GET' || method === 'PUT')) {
    return await settings(request, env)
  }
  if (pathname === '/duel/stats' && method === 'GET') {
    return await stats(request, env)
  }
  const ws = ROOM_WS.exec(pathname)?.groups?.id
  if (ws && method === 'GET') {
    return await roomSocket(request, env, url, ws)
  }
  const room = ROOM.exec(pathname)?.groups?.id
  if (room && method === 'GET') {
    return await summary(request, env, room)
  }
  return null
}
