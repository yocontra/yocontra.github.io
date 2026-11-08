/**
 * Frontier: lobby directory joins and lobby WebSockets. Owned by stream F.
 *   POST /town/join          (Bearer) { turnstileToken, lobbyId?, bots? } → TownJoinResponse;
 *                            403 `turnstile`, 403 `unlicensed`, 409 `outdated` (no or old `wire`)
 *                            (with `licence: { cleared, remaining }`), 503 full/over budget
 *   GET  /town/lobbies       → TownDirectoryView (for the hub tile)
 *   GET  /town/:lobby/ws     ?ticket=&sig= → WebSocket into that Lobby DO
 *   GET  /town/:lobby/stats  dev only: tick timing and traffic counters (load tests)
 */

import { COLLISION_VERSION } from '../../../src/experiments/out-west/content/manifest.ts'
import {
  TOWN_WIRE_VERSION,
  type TownJoinRefusal,
  type TownJoinRequest,
} from '../../../src/experiments/out-west/contract/town.ts'
import { licenceStatus } from '../../../src/experiments/out-west/data/licence.ts'
import { PROTOCOL_VERSION } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { authenticate } from '../auth/session.ts'
import { AccountGoneError, issueTicket, redeemTicket } from '../auth/ticket.ts'
import { getProfileDetail } from '../economy/profile.ts'
import type { Env } from '../env.ts'
import {
  allowedOrigin,
  BODY_STANDARD,
  error,
  json,
  type RouteHandler,
  readJson,
  verifyTurnstile,
} from '../http.ts'
import { accountFlags, isShadowed } from '../moderation/flags.ts'
import { LOBBY_WIRE_HEADER } from '../town/wire.ts'

const LOBBY_PATH = /^\/town\/(?<lobby>lobby:\d{1,3})\/(?<what>ws|stats)$/u
const NATIVE_PATH = /^\/town\/(?<lobby>lobby:\d{1,3})\/native\/(?<room>[a-f0-9]{64})$/u
const DIRECTORY = 'dir:global'
const SIG_TTL_MS = 60_000

const isDev = (env: Env): boolean => env.RP_ID === 'localhost'

/** The next UTC daily reset for the "town's closed" message. */
export function reopensOn(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

export function refusalMessage(reason: TownJoinRefusal, now = new Date()): string {
  switch (reason) {
    case 'over_budget':
      return `Perdition is closed for the rest of the day. It reopens on ${reopensOn(now)} (UTC). Quick Draw is still open.`
    case 'all_full':
      return 'Every lobby in Perdition is full. Try again in a minute.'
    case 'unlicensed':
      return 'Beat the first 3 outlaws on a ranked run to earn your licence.'
    case 'turnstile':
      return 'Could not verify you are human. Try again.'
    case 'outdated':
      return 'Perdition has been updated. Refresh the page to ride in.'
    default:
      return 'Sign in with a passkey to ride into town.'
  }
}

/** Binds the account, chosen lobby and exact wire version; cached older URLs cannot reach the DO. */
async function lobbySig(
  env: Env,
  lobbyId: string,
  accountId: string,
  exp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`town:v${TOWN_WIRE_VERSION}:${env.AUTH_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${lobbyId}|${accountId}|${exp}`),
  )
  return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function join(request: Request, env: Env): Promise<Response> {
  if (!allowedOrigin(request, env)) {
    return error(request, env, 403, 'Origin not allowed.')
  }
  const player = await authenticate(request, env)
  if (!player) {
    return json(
      request,
      env,
      { ok: false, error: refusalMessage('unauthorized'), reason: 'unauthorized' },
      401,
    )
  }
  // The Bounty Hunt licence gates Frontier too (§1): the first 3 outlaws cleared on a ranked run.
  const profile = await getProfileDetail(env, player.accountId)
  if (!(profile && licenceStatus(profile.gauntletClears).licensed)) {
    const status = licenceStatus(profile?.gauntletClears ?? 0)
    return json(
      request,
      env,
      {
        ok: false,
        error: refusalMessage('unlicensed'),
        reason: 'unlicensed',
        licence: { cleared: status.cleared, remaining: status.remaining },
      },
      403,
    )
  }
  // Turnstile tokens run to ~2 KB.
  const body = ((await readJson(request, BODY_STANDARD)) ?? {}) as TownJoinRequest
  // A page loaded before a wire change would misread every snapshot: send it to refresh instead.
  if (
    body.wire !== TOWN_WIRE_VERSION ||
    Reflect.get(body, 'protocol') !== PROTOCOL_VERSION ||
    Reflect.get(body, 'collision') !== COLLISION_VERSION
  ) {
    return json(
      request,
      env,
      { ok: false, error: refusalMessage('outdated'), reason: 'outdated' },
      409,
    )
  }
  // §8: Turnstile at every lobby join, rejoins included (each token is single use).
  const token = body.turnstileToken
  if (!(typeof token === 'string' && token && (await verifyTurnstile(token, request, env)))) {
    return json(
      request,
      env,
      { ok: false, error: refusalMessage('turnstile'), reason: 'turnstile' },
      403,
    )
  }
  const preferred =
    typeof body.lobbyId === 'string' && LOBBY_PATH.test(`/town/${body.lobbyId}/ws`)
      ? body.lobbyId
      : undefined
  const dir = env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName(DIRECTORY))
  const flags = await accountFlags(env, player.accountId)
  const assigned = await dir.assign(
    player.accountId,
    preferred,
    isShadowed(flags) ? 'badlands' : 'main',
  )
  if (!assigned.ok) {
    return json(
      request,
      env,
      { ok: false, error: refusalMessage(assigned.reason), reason: assigned.reason },
      503,
      {
        'Retry-After': assigned.reason === 'all_full' ? '60' : '86400',
      },
    )
  }
  let ticket: string
  try {
    ticket = await issueTicket(env, player, 'town')
  } catch (err) {
    if (err instanceof AccountGoneError) {
      return json(
        request,
        env,
        { ok: false, error: refusalMessage('unauthorized'), reason: 'unauthorized' },
        401,
      )
    }
    throw err
  }
  const exp = Date.now() + SIG_TTL_MS
  const ws = new URL(request.url)
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
  ws.pathname = `/town/${assigned.lobbyId}/ws`
  ws.search = ''
  ws.searchParams.set('ticket', ticket)
  ws.searchParams.set('exp', String(exp))
  ws.searchParams.set('sig', await lobbySig(env, assigned.lobbyId, player.accountId, exp))
  const bots = Number(body.bots ?? Number.NaN)
  if (isDev(env) && Number.isInteger(bots) && bots >= 0) {
    ws.searchParams.set('bots', String(Math.min(31, bots)))
  }
  {
    const lobby = env.LOBBIES.get(env.LOBBIES.idFromName(assigned.lobbyId))
    const reservation = await lobby.reserveNative(
      assigned.lobbyId,
      player.accountId,
      PROTOCOL_VERSION,
    )
    if ('refused' in reservation) {
      await dir.cancelAssignment(assigned.lobbyId, player.accountId)
      return json(
        request,
        env,
        { ok: false, error: refusalMessage('over_budget'), reason: 'over_budget' },
        503,
        { 'Retry-After': '86400' },
      )
    }
    ws.pathname = `/town/${assigned.lobbyId}/native/${reservation.roomId}`
    return json(
      request,
      env,
      {
        lobbyId: assigned.lobbyId,
        wsUrl: ws.toString(),
        players: assigned.players,
        banked: profile.purse,
        reservation,
      },
      201,
    )
  }
}

async function connect(
  request: Request,
  env: Env,
  url: URL,
  target: { lobbyId: string; nativeRoom?: string },
): Promise<Response> {
  const { lobbyId, nativeRoom } = target
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  if (!allowedOrigin(request, env)) {
    return new Response('Origin not allowed', { status: 403 })
  }
  const player = await redeemTicket(env, url.searchParams.get('ticket') ?? '', 'town')
  const exp = Number(url.searchParams.get('exp'))
  if (!(player && exp > Date.now())) {
    return new Response('Ticket expired', { status: 401 })
  }
  if (url.searchParams.get('sig') !== (await lobbySig(env, lobbyId, player.accountId, exp))) {
    return new Response('Wrong town', { status: 403 })
  }
  const headers = new Headers(request.headers)
  headers.set(LOBBY_WIRE_HEADER, String(TOWN_WIRE_VERSION))
  headers.delete('X-Native-Room')
  if (nativeRoom) {
    headers.set('X-Native-Room', nativeRoom)
  }
  headers.set('X-Lobby-Id', lobbyId)
  headers.set('X-Account-Id', player.accountId)
  headers.set('X-Name', player.name)
  const tcp = (request.cf as { clientTcpRtt?: number } | undefined)?.clientTcpRtt
  headers.set('X-Tcp-Rtt', String(tcp ?? ''))
  // Dev only; production lobbies never see the header (ambient bots, no load-test targets).
  const bots = url.searchParams.get('bots')
  if (isDev(env) && bots !== null) {
    headers.set('X-Bots', bots)
  } else {
    headers.delete('X-Bots')
  }
  const lobby = env.LOBBIES.get(env.LOBBIES.idFromName(lobbyId))
  return lobby.fetch(new Request(request, { headers }))
}

export const townRoutes: RouteHandler = async (request, env, url) => {
  if (url.pathname === '/town/native/join' && request.method === 'POST') {
    return join(request, env)
  }
  const nativePath = NATIVE_PATH.exec(url.pathname)
  const nativeLobby = nativePath?.groups?.lobby
  const nativeRoom = nativePath?.groups?.room
  if (nativeLobby && nativeRoom && request.method === 'GET') {
    return connect(request, env, url, { lobbyId: nativeLobby, nativeRoom })
  }
  if (url.pathname === '/town/join' && request.method === 'POST') {
    return join(request, env)
  }
  if (url.pathname === '/town/lobbies' && request.method === 'GET') {
    const dir = env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName(DIRECTORY))
    return json(request, env, await dir.view())
  }
  const match = LOBBY_PATH.exec(url.pathname)
  const lobbyId = match?.groups?.lobby
  if (!lobbyId || request.method !== 'GET') {
    return null
  }
  if (match.groups?.what === 'stats') {
    if (!isDev(env)) {
      return null
    }
    const lobby = env.LOBBIES.get(env.LOBBIES.idFromName(lobbyId))
    return lobby.fetch(new Request(new URL('/stats', url).toString()))
  }
  return new Response('The game has been updated. Refresh to reconnect.', { status: 410 })
}
