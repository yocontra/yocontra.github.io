/**
 * Ranked single-player gauntlet sessions. Owned by stream B.
 *   POST /sessions             { turnstileToken } → { sessionId, wsUrl }
 *   GET  /sessions/:id/ws      WebSocket upgrade into that run's DuelSession
 */
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
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE client_hash = ? AND created_at > ?',
    )
      .bind(hash, now - HOUR_MS)
      .first<{ n: number }>()
    if ((recent?.n ?? 0) >= SESSIONS_PER_HOUR) {
      return json(request, env, { ok: false, error: 'Easy, partner. Try again in a bit.' }, 429, {
        'Retry-After': '600',
      })
    }
    const id = env.DUELS.newUniqueId().toString()
    await env.DB.prepare('INSERT INTO sessions (id, client_hash, created_at) VALUES (?, ?, ?)')
      .bind(id, hash, now)
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
  const session = await env.DB.prepare('SELECT client_hash FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ client_hash: string }>()
  if (!session) {
    return new Response('Unknown session', { status: 404 })
  }
  const stub = env.DUELS.get(env.DUELS.idFromString(id))
  const headers = new Headers(request.headers)
  headers.set('X-Session-Id', id)
  headers.set('X-Client-Hash', session.client_hash)
  return stub.fetch(new Request(request, { headers }))
}
