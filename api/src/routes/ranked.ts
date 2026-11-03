/**
 * Ranked single-player gauntlet sessions. Owned by stream B.
 *   POST /sessions             { turnstileToken } → { sessionId, wsUrl }
 *                              Optional `Authorization: Bearer`: the run belongs to that account.
 *   GET  /sessions/:id/ws      WebSocket upgrade into that run's DuelSession
 */
import { authenticate, getProfile } from '../duel/external.ts'
import type { Env } from '../env.ts'
import {
  allowedOrigin,
  clientHash,
  error,
  json,
  type RouteHandler,
  readJson,
  verifyTurnstile,
} from '../http.ts'

const SESSIONS_PER_HOUR = 30
const HOUR_MS = 60 * 60 * 1000
const WS_PATH = /^\/sessions\/(?<id>[0-9a-f]{64})\/ws$/u
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * Local dev (wrangler dev) has no CF-Connecting-IP, so every client hashes to the same "unknown"
 * and would share one hourly allowance. Production always has the header, so this never relaxes it.
 */
function isLocalDev(request: Request): boolean {
  const ip = request.headers.get('CF-Connecting-IP')
  return ip === null || LOOPBACK.has(ip)
}

async function rateLimited(
  request: Request,
  env: Env,
  hash: string,
  now: number,
): Promise<boolean> {
  if (isLocalDev(request)) {
    return false
  }
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE client_hash = ? AND created_at > ?',
  )
    .bind(hash, now - HOUR_MS)
    .first<{ n: number }>()
  return (recent?.n ?? 0) >= SESSIONS_PER_HOUR
}

export const rankedRoutes: RouteHandler = async (request, env, url) => {
  if (url.pathname === '/sessions' && request.method === 'POST') {
    if (!allowedOrigin(request, env)) {
      return error(request, env, 403, 'Origin not allowed.')
    }
    const body = (await readJson(request, 8 * 1024)) as { turnstileToken?: unknown } | undefined
    const token = body?.turnstileToken
    if (typeof token !== 'string' || !(await verifyTurnstile(token, request, env))) {
      return error(request, env, 403, 'Could not verify you are human.')
    }
    const hash = await clientHash(request)
    const now = Date.now()
    if (await rateLimited(request, env, hash, now)) {
      return json(request, env, { ok: false, error: 'Easy, partner. Try again in a bit.' }, 429, {
        'Retry-After': '600',
      })
    }
    const player = await authenticate(request, env)
    const id = env.DUELS.newUniqueId().toString()
    await env.DB.prepare(
      'INSERT INTO sessions (id, client_hash, created_at, account_id) VALUES (?, ?, ?, ?)',
    )
      .bind(id, hash, now, player?.accountId ?? null)
      .run()
    const ws = new URL(request.url)
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
    ws.pathname = `/sessions/${id}/ws`
    ws.search = ''
    return json(request, env, { sessionId: id, wsUrl: ws.toString() }, 201)
  }

  const match = WS_PATH.exec(url.pathname)
  const id = match?.groups?.id
  if (!id || request.method !== 'GET') {
    return null
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  if (!allowedOrigin(request, env)) {
    return new Response('Origin not allowed', { status: 403 })
  }
  const session = await env.DB.prepare('SELECT client_hash, account_id FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ client_hash: string; account_id: string | null }>()
  if (!session) {
    return new Response('Unknown session', { status: 404 })
  }
  const stub = env.DUELS.get(env.DUELS.idFromString(id))
  const headers = new Headers(request.headers)
  headers.set('X-Session-Id', id)
  headers.set('X-Client-Hash', session.client_hash)
  headers.delete('X-Account-Id')
  headers.delete('X-Account-Name')
  if (session.account_id) {
    // The name is the account's current one, so a signed-in run lands on the board under it.
    const owner = await getProfile(env, session.account_id).catch(() => null)
    headers.set('X-Account-Id', session.account_id)
    headers.set('X-Account-Name', owner?.name ?? '')
  }
  return stub.fetch(new Request(request, { headers }))
}
