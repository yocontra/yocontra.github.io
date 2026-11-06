/**
 * Ranked single-player gauntlet sessions. Owned by stream B.
 *   POST /sessions             { turnstileToken } → RankedSessionResponse (201)
 *                              Optional `Authorization: Bearer`: the run belongs to that account.
 *                              503 { reason: 'over_budget' } once the month's spend cap is reached.
 *   GET  /sessions/:id/ws      WebSocket upgrade into that run's DuelSession
 *                              `?resume=<resumeToken>` resumes the run after a drop (30 s window).
 * Protocol and resume rules: `contract/ranked.ts`.
 */
import type {
  RankedRefusal,
  RankedSessionResponse,
} from '../../../src/experiments/out-west/contract/ranked.ts'
import { budgetState } from '../budget.ts'
import { authenticate, getProfile } from '../duel/external.ts'
import type { Env } from '../env.ts'
import {
  allowedOrigin,
  BODY_STANDARD,
  clientHash,
  error,
  json,
  type RouteHandler,
  readJson,
  verifyTurnstile,
} from '../http.ts'
import { resumeToken, verifyResumeToken } from '../ranked/resume-token.ts'

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
    const body = (await readJson(request, BODY_STANDARD)) as
      | { turnstileToken?: unknown }
      | undefined
    const token = body?.turnstileToken
    if (typeof token !== 'string' || !(await verifyTurnstile(token, request, env))) {
      return error(request, env, 403, 'Couldn’t verify this device. Try again.')
    }
    // The $5/month cap (§14): ranked runs are Durable Object time like duels, so they close with them.
    if (!(await budgetState(env)).duelsOpen) {
      const refusal: RankedRefusal = {
        ok: false,
        error: 'Ranked is closed until next month. Practice is still open.',
        reason: 'over_budget',
      }
      return json(request, env, refusal, 503, { 'Retry-After': '86400' })
    }
    const hash = await clientHash(request)
    const now = Date.now()
    if (await rateLimited(request, env, hash, now)) {
      return json(
        request,
        env,
        { ok: false, error: 'Too many requests. Wait a moment and try again.' },
        429,
        {
          'Retry-After': '600',
        },
      )
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
    const out: RankedSessionResponse = {
      sessionId: id,
      wsUrl: ws.toString(),
      resumeToken: await resumeToken(env, id),
    }
    return json(request, env, out, 201)
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
  const resume = url.searchParams.get('resume')
  if (resume !== null && !(await verifyResumeToken(env, id, resume))) {
    return new Response('Bad resume token', { status: 403 })
  }
  const stub = env.DUELS.get(env.DUELS.idFromString(id))
  const headers = new Headers(request.headers)
  headers.set('X-Resume', resume === null ? '0' : '1')
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
