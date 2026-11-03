/**
 * out-west leaderboard API (Cloudflare Worker + D1).
 *
 *   GET  /leaderboard?limit=25  → best run per player name, highest first
 *   POST /runs                  → { name, run } — validated, re-scored server-side, stored
 */
import { validateName } from './names.ts'
import { validateRun } from './runs.ts'

export interface Env {
  DB: D1Database
  /** Comma-separated list of origins allowed to call the API from a browser. */
  ALLOWED_ORIGINS: string
}

const MAX_BODY_BYTES = 64 * 1024
const RATE_LIMIT_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin')
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  if (!(origin && allowed.includes(origin))) {
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

interface BoardRow {
  name: string
  total: number
  created_at: number
}

async function leaderboard(env: Env, limit: number): Promise<BoardRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, total, created_at FROM (
       SELECT name, total, created_at,
              ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY total DESC, created_at ASC) AS rn
       FROM runs
     )
     WHERE rn = 1
     ORDER BY total DESC, created_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<BoardRow>()
  return results
}

async function rankOf(env: Env, total: number, nameKey: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS ahead FROM (
       SELECT name_key, MAX(total) AS best FROM runs GROUP BY name_key
     ) WHERE best > ? AND name_key != ?`,
  )
    .bind(total, nameKey)
    .first<{ ahead: number }>()
  return (row?.ahead ?? 0) + 1
}

async function handleGet(url: URL, env: Env, cors: Record<string, string>): Promise<Response> {
  const requested = Number(url.searchParams.get('limit') ?? 25)
  const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 25
  const rows = await leaderboard(env, limit)
  return json(
    {
      entries: rows.map((row, i) => ({
        rank: i + 1,
        name: row.name,
        total: row.total,
        createdAt: row.created_at,
      })),
    },
    200,
    cors,
    { 'Cache-Control': 'public, max-age=15' },
  )
}

async function handlePost(request: Request, env: Env, cors: Record<string, string>) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) {
    return json({ ok: false, error: 'Expected JSON.' }, 415, cors)
  }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'Too large.' }, 413, cors)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400, cors)
  }
  if (typeof body !== 'object' || body === null) {
    return json({ ok: false, error: 'Invalid body.' }, 400, cors)
  }
  const { name: rawName, run: rawRun } = body as { name?: unknown; run?: unknown }

  const name = validateName(rawName)
  if (!name.ok) {
    return json({ ok: false, error: name.error }, 400, cors)
  }
  const run = validateRun(rawRun)
  if (!run.ok) {
    return json({ ok: false, error: run.error }, 422, cors)
  }

  const hash = await clientHash(request)
  const now = Date.now()
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM runs WHERE client_hash = ? AND created_at > ?',
  )
    .bind(hash, now - HOUR_MS)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return json({ ok: false, error: 'Easy, partner. Try again in a bit.' }, 429, cors, {
      'Retry-After': '600',
    })
  }

  if (run.run.total > 0) {
    await env.DB.prepare(
      `INSERT INTO runs (id, name, name_key, total, duels, wins, economy_version, client_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        name.name,
        name.key,
        run.run.total,
        run.run.duels.length,
        run.run.wins,
        1,
        hash,
        now,
      )
      .run()
  }

  const rank = await rankOf(env, run.run.total, name.key)
  return json({ ok: true, total: run.run.total, rank }, 201, cors)
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
        return await handleGet(url, env, cors)
      }
      if (url.pathname === '/runs' && request.method === 'POST') {
        return await handlePost(request, env, cors)
      }
      return json({ ok: false, error: 'Not found.' }, 404, cors)
    } catch (error) {
      console.error('leaderboard error', error)
      return json({ ok: false, error: 'Something went wrong.' }, 500, cors)
    }
  },
} satisfies ExportedHandler<Env>
