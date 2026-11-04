/**
 * The Daily Outlaw (meta-game stream). Contract: `contract/meta.ts`.
 *   GET  /daily                   (Bearer optional) → DailyResponse
 *   POST /daily/sessions          { turnstileToken?, unposted? } (Bearer optional)
 *                                 → RankedSessionResponse 201; 429 out of tries, 503 over budget,
 *                                 403 origin, or 403 `turnstile` (signed in, no valid token, not
 *                                 `unposted`).
 *   GET  /daily/sessions/:id/ws   WebSocket into that attempt's DailySession (one socket, ever)
 *   GET  /daily/board?day=        (Bearer optional) → DailyBoardResponse
 *
 * Tries are counted per account when signed in, per network (the daily client hash) as a guest.
 * Guests can duel the Daily Outlaw but never post on the board or get paid.
 *
 * Turnstile gates only what a try can post or pay. A guest's try never needs a token: it posts
 * nothing, and its tries are still counted per network. Signed in, a valid token makes the try the
 * account's (the board, the pay). Without one the server refuses with `reason: 'turnstile'`, and
 * the client offers a retry or `unposted`: the try runs as a guest's (no board, no pay). This keeps
 * the Daily playable where the Turnstile widget can't run (headless or embedded browsers, error
 * 600010; see RELEASE.md).
 */
import type { DailyResponse } from '../../../src/experiments/out-west/contract/meta.ts'
import type { RankedSessionResponse } from '../../../src/experiments/out-west/contract/ranked.ts'
import {
  DAILY_ATTEMPTS,
  dailySpec,
  dayEnds,
  dayKey,
  isDayKey,
} from '../../../src/experiments/out-west/data/daily.ts'
import { budgetState } from '../budget.ts'
import { dailyBoard } from '../daily/board.ts'
import { authenticate } from '../economy/auth.ts'
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

const WS_PATH = /^\/daily\/sessions\/(?<id>[0-9a-f]{64})\/ws$/u
/** A ticket issued before midnight may still be dueled this long after it. */
const MIDNIGHT_GRACE_MS = 10 * 60 * 1000
/** A ticket must be used this soon after it is issued. */
const TICKET_TTL_MS = 5 * 60 * 1000

type Verify = (token: string, request: Request, env: Env) => Promise<boolean>

async function triesToday(
  env: Env,
  day: string,
  account: string | null,
  hash: string,
): Promise<{ tries: number; best: number | null; paid: boolean }> {
  const row = account
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n, MIN(CASE WHEN outcome = 'win' THEN reaction_ms END) AS best
         FROM daily_runs WHERE day = ? AND account_id = ?`,
      )
        .bind(day, account)
        .first<{ n: number; best: number | null }>()
    : await env.DB.prepare(
        `SELECT COUNT(*) AS n, MIN(CASE WHEN outcome = 'win' THEN reaction_ms END) AS best
         FROM daily_runs WHERE day = ? AND client_hash = ? AND account_id IS NULL`,
      )
        .bind(day, hash)
        .first<{ n: number; best: number | null }>()
  let paid = false
  if (account) {
    const p = await env.DB.prepare('SELECT 1 AS yes FROM ledger WHERE idem_key = ?')
      .bind(`daily:${account}:${day}#0`)
      .first<{ yes: number }>()
    paid = p !== null
  }
  return { tries: row?.n ?? 0, best: row?.best ?? null, paid }
}

async function today(request: Request, env: Env): Promise<Response> {
  const day = dayKey()
  const player = await authenticate(request, env)
  const t = await triesToday(env, day, player?.accountId ?? null, await clientHash(request))
  const out: DailyResponse = {
    spec: dailySpec(day),
    tries: t.tries,
    maxTries: DAILY_ATTEMPTS,
    best: t.best,
    paid: t.paid,
    endsAt: dayEnds(day),
  }
  return json(request, env, out)
}

async function issue(request: Request, env: Env, verify: Verify): Promise<Response> {
  if (!allowedOrigin(request, env)) {
    return error(request, env, 403, 'Origin not allowed.')
  }
  const body = (await readJson(request, 8 * 1024)) as
    | { turnstileToken?: unknown; unposted?: unknown }
    | undefined
  const player = await authenticate(request, env)
  const token = body?.turnstileToken
  // a guest's try posts nothing, so it never spends a siteverify call
  const verified =
    player !== null &&
    typeof token === 'string' &&
    token !== '' &&
    (await verify(token, request, env))
  if (player && !verified && body?.unposted !== true) {
    return json(
      request,
      env,
      {
        ok: false,
        error: 'Couldn’t verify this device. Your time can’t be posted.',
        reason: 'turnstile',
      },
      403,
    )
  }
  if (!(await budgetState(env)).duelsOpen) {
    return json(
      request,
      env,
      {
        ok: false,
        error: 'The Daily Outlaw is closed until next month.',
        reason: 'over_budget',
      },
      503,
      { 'Retry-After': '86400' },
    )
  }
  // an unverified try is a guest's: counted per network, never posted or paid
  const account = verified ? (player?.accountId ?? null) : null
  const hash = await clientHash(request)
  const day = dayKey()
  const t = await triesToday(env, day, account, hash)
  if (t.tries >= DAILY_ATTEMPTS) {
    return json(
      request,
      env,
      { ok: false, error: `That’s your ${DAILY_ATTEMPTS} tries for today. Come back tomorrow.` },
      429,
      { 'Retry-After': String(Math.ceil((dayEnds(day) - Date.now()) / 1000)) },
    )
  }
  const id = env.DAILY_SESSIONS.newUniqueId().toString()
  const now = Date.now()
  // The guard re-counts inside the insert, so two tabs racing can't take a fourth try.
  const inserted = await env.DB.prepare(
    `INSERT INTO daily_runs (id, day, account_id, name, client_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE (SELECT COUNT(*) FROM daily_runs
            WHERE day = ?2 AND ((?3 IS NOT NULL AND account_id = ?3)
               OR (?3 IS NULL AND account_id IS NULL AND client_hash = ?5))) < ?7`,
  )
    .bind(id, day, account, account ? (player?.name ?? null) : null, hash, now, DAILY_ATTEMPTS)
    .run()
  if ((inserted.meta.changes ?? 0) === 0) {
    return error(request, env, 429, 'No tries left today. Come back tomorrow.')
  }
  const ws = new URL(request.url)
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
  ws.pathname = `/daily/sessions/${id}/ws`
  ws.search = ''
  // no resume: a dropped daily duel is void
  const out: RankedSessionResponse = { sessionId: id, wsUrl: ws.toString(), resumeToken: '' }
  return json(request, env, out, 201)
}

async function socket(request: Request, env: Env, id: string): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  if (!allowedOrigin(request, env)) {
    return new Response('Origin not allowed', { status: 403 })
  }
  const row = await env.DB.prepare(
    'SELECT day, account_id, outcome, created_at FROM daily_runs WHERE id = ?',
  )
    .bind(id)
    .first<{ day: string; account_id: string | null; outcome: string | null; created_at: number }>()
  if (!row) {
    return new Response('Unknown ticket', { status: 404 })
  }
  const now = Date.now()
  if (row.outcome !== null || now - row.created_at > TICKET_TTL_MS) {
    return new Response('This ticket is used.', { status: 410 })
  }
  if (now > dayEnds(row.day) + MIDNIGHT_GRACE_MS) {
    return new Response('That day is over.', { status: 410 })
  }
  const headers = new Headers(request.headers)
  headers.set('X-Daily-Id', id)
  headers.set('X-Day', row.day)
  headers.delete('X-Account-Id')
  if (row.account_id) {
    headers.set('X-Account-Id', row.account_id)
  }
  const stub = env.DAILY_SESSIONS.get(env.DAILY_SESSIONS.idFromString(id))
  return await stub.fetch(new Request(request, { headers }))
}

/** The daily routes; `verify` is Turnstile (swapped out in tests). */
export function makeDailyRoutes(verify: Verify = verifyTurnstile): RouteHandler {
  return async (request, env, url) => {
    if (!url.pathname.startsWith('/daily')) {
      return null
    }
    if (url.pathname === '/daily' && request.method === 'GET') {
      return await today(request, env)
    }
    if (url.pathname === '/daily/sessions' && request.method === 'POST') {
      return await issue(request, env, verify)
    }
    if (url.pathname === '/daily/board' && request.method === 'GET') {
      const asked = url.searchParams.get('day')
      const day = asked && isDayKey(asked) ? asked : dayKey()
      const player = await authenticate(request, env)
      return json(request, env, await dailyBoard(env, day, player?.accountId ?? null))
    }
    const id = WS_PATH.exec(url.pathname)?.groups?.id
    if (id && request.method === 'GET') {
      return await socket(request, env, id)
    }
    return null
  }
}

export const dailyRoutes: RouteHandler = makeDailyRoutes()
