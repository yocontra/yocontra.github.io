/**
 * out-west leaderboard API (Cloudflare Worker + D1 + Durable Objects).
 *
 *   GET  /leaderboard?limit=25   best unflagged run per player name, highest first
 *   POST /sessions               { turnstileToken } → a ranked session and its WebSocket URL
 *   GET  /sessions/:id/ws        WebSocket upgrade into that session's DuelSession object
 *
 * Scores are never submitted by the client: a DuelSession runs every ranked duel server-side and
 * writes the final purse to D1 itself.
 */
import type { DuelSession } from './session.ts'

// biome-ignore lint/performance/noBarrelFile: the Workers runtime needs the Durable Object class exported from the entry module
export { DuelSession } from './session.ts'

export interface Env {
  DB: D1Database
  DUELS: DurableObjectNamespace<DuelSession>
  /** Comma-separated list of origins allowed to call the API from a browser. */
  ALLOWED_ORIGINS: string
  /** Cloudflare Turnstile secret. Local dev uses Cloudflare's always-pass test secret. */
  TURNSTILE_SECRET: string
}

const SESSIONS_PER_HOUR = 30
const HOUR_MS = 60 * 60 * 1000
const MAX_BODY_BYTES = 8 * 1024
const WS_PATH = /^\/sessions\/(?<id>[0-9a-f]{64})\/ws$/u

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin')
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  return origin && allowed.includes(origin) ? origin : null
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = allowedOrigin(request, env)
  if (!origin) {
    return {}
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(
  body: unknown,
  status: number,
  cors: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra },
  })
}

async function clientHash(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const day = new Date().toISOString().slice(0, 10)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${day}`))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function verifyTurnstile(token: string, request: Request, env: Env): Promise<boolean> {
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET)
  form.append('response', token)
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) {
    form.append('remoteip', ip)
  }
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  })
  const outcome = await res.json<{ success: boolean }>()
  return outcome.success
}

interface BoardRow {
  name: string
  total: number
  created_at: number
}

async function handleLeaderboard(url: URL, env: Env, cors: Record<string, string>) {
  const requested = Number(url.searchParams.get('limit') ?? 25)
  const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 25
  const { results } = await env.DB.prepare(
    `SELECT name, total, created_at FROM (
       SELECT name, total, created_at,
              ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY total DESC, created_at ASC) AS rn
       FROM runs WHERE flagged = 0
     )
     WHERE rn = 1
     ORDER BY total DESC, created_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<BoardRow>()
  const entries = results.map((row, i) => ({
    rank: i + 1,
    name: row.name,
    total: row.total,
    createdAt: row.created_at,
  }))
  return json({ entries }, 200, cors, { 'Cache-Control': 'public, max-age=15' })
}

async function handleCreateSession(request: Request, env: Env, cors: Record<string, string>) {
  if (!allowedOrigin(request, env)) {
    return json({ ok: false, error: 'Origin not allowed.' }, 403, cors)
  }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'Too large.' }, 413, cors)
  }
  let token: unknown
  try {
    token = (JSON.parse(text) as { turnstileToken?: unknown }).turnstileToken
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400, cors)
  }
  if (typeof token !== 'string' || !(await verifyTurnstile(token, request, env))) {
    return json({ ok: false, error: 'Could not verify you are human.' }, 403, cors)
  }

  const hash = await clientHash(request)
  const now = Date.now()
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE client_hash = ? AND created_at > ?',
  )
    .bind(hash, now - HOUR_MS)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= SESSIONS_PER_HOUR) {
    return json({ ok: false, error: 'Easy, partner. Try again in a bit.' }, 429, cors, {
      'Retry-After': '600',
    })
  }

  const id = env.DUELS.newUniqueId().toString()
  await env.DB.prepare('INSERT INTO sessions (id, client_hash, created_at) VALUES (?, ?, ?)')
    .bind(id, hash, now)
    .run()
  const url = new URL(request.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${id}/ws`
  url.search = ''
  return json({ sessionId: id, wsUrl: url.toString() }, 201, cors)
}

async function handleConnect(request: Request, env: Env, id: string): Promise<Response> {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }
    try {
      if (url.pathname === '/leaderboard' && request.method === 'GET') {
        return await handleLeaderboard(url, env, cors)
      }
      if (url.pathname === '/sessions' && request.method === 'POST') {
        return await handleCreateSession(request, env, cors)
      }
      const ws = WS_PATH.exec(url.pathname)
      if (ws?.groups?.id && request.method === 'GET') {
        return await handleConnect(request, env, ws.groups.id)
      }
      return json({ ok: false, error: 'Not found.' }, 404, cors)
    } catch (error) {
      console.error('leaderboard error', error)
      return json({ ok: false, error: 'Something went wrong.' }, 500, cors)
    }
  },
} satisfies ExportedHandler<Env>
