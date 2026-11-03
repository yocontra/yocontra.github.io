/**
 * The shared board, public posters, moderation and the saloon. Owned by stream C. Types and the
 * full endpoint list: `contract/social.ts` and `contract/economy.ts`.
 *   GET    /board/most-wanted?month=&limit=   → MostWantedResponse   (Bearer optional)
 *   GET    /players/:name                     → PlayerPoster         (Bearer optional)
 *   GET    /saloon/chalkboard                 → ChalkboardResponse
 *   POST   /saloon/round                      RoundRequest → RoundResponse (Bearer)
 *   POST   /reports                           ReportRequest → ReportResponse (Bearer)
 *   GET    /blocks                            → BlocksResponse (Bearer)
 *   POST   /blocks                            BlockRequest → BlocksResponse (Bearer)
 *   DELETE /blocks | /blocks/:name            BlockRequest → BlocksResponse (Bearer)
 */
import type { MostWantedResponse } from '../../../src/experiments/out-west/contract/economy.ts'
import {
  type BlocksResponse,
  type ChalkboardResponse,
  REPORT_REASONS,
  type ReportReason,
  type ReportResponse,
  type RoundResponse,
} from '../../../src/experiments/out-west/contract/social.ts'
import {
  isMonth,
  MOST_WANTED_MAX_LIMIT,
  MOST_WANTED_WINNERS,
  monthOf,
} from '../../../src/experiments/out-west/data/sinks.ts'
import { authenticate, type Player } from '../economy/auth.ts'
import { mostWanted } from '../economy/board.ts'
import { isOverdraft } from '../economy/ledger.ts'
import { getProfile } from '../economy/profile.ts'
import { chalkboard, requestIdOf, roundStatements } from '../economy/sinks.ts'
import type { Env } from '../env.ts'
import { error, json, type RouteHandler, readJson } from '../http.ts'
import { block, blockedNames, fileReport, unblock } from '../moderation/reports.ts'
import { accountByName } from '../social/lookup.ts'
import { playerPoster } from '../social/players.ts'

const PLAYER_PATH = /^\/players\/(?<name>[^/]{1,96})$/u
const BLOCK_PATH = /^\/blocks\/(?<name>[^/]{1,96})$/u
const SIGN_IN = 'Sign in first, partner.'

const decode = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

async function board(request: Request, env: Env, url: URL): Promise<Response> {
  const asked = url.searchParams.get('month')
  const now = Date.now()
  const month = isMonth(asked) && asked <= monthOf(now) ? asked : monthOf(now)
  const n = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(n)
    ? Math.min(MOST_WANTED_MAX_LIMIT, Math.max(1, n))
    : MOST_WANTED_WINNERS
  const player = await authenticate(request, env)
  const body: MostWantedResponse = await mostWanted(env, {
    month,
    limit,
    accountId: player?.accountId ?? null,
    now,
  })
  return json(request, env, body, 200, {
    'Cache-Control': player ? 'private, no-store' : 'public, max-age=60',
  })
}

async function round(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 1024)) as { requestId?: unknown } | undefined
  const profile = await getProfile(env, player.accountId)
  if (!profile) {
    return error(request, env, 404, 'No profile.')
  }
  try {
    await env.DB.batch(
      roundStatements(env, {
        accountId: player.accountId,
        name: profile.name,
        requestId: requestIdOf(body?.requestId),
      }),
    )
  } catch (err) {
    if (isOverdraft(err)) {
      return error(request, env, 402, "You can't stand the house a round on what you've got.")
    }
    throw err
  }
  const after = await getProfile(env, player.accountId)
  const out: RoundResponse = { ok: true, purse: after?.purse ?? 0, rounds: await chalkboard(env) }
  return json(request, env, out)
}

async function report(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 2048)) as
    | { name?: unknown; reason?: unknown; context?: unknown; block?: unknown }
    | undefined
  const reason = body?.reason
  if (!(REPORT_REASONS as readonly unknown[]).includes(reason)) {
    return error(request, env, 400, 'Pick a reason.')
  }
  const target = await accountByName(env, body?.name)
  if (!target) {
    return error(request, env, 404, 'No gunslinger by that name.')
  }
  if (target.id === player.accountId) {
    return error(request, env, 400, "You can't report yourself.")
  }
  const context =
    typeof body?.context === 'string' && body.context.length <= 80 ? body.context : null
  await fileReport(env, {
    reporterId: player.accountId,
    targetId: target.id,
    reason: reason as ReportReason,
    context,
  })
  const blocked =
    body?.block === true
      ? await block(env, { blockerId: player.accountId, targetId: target.id })
      : false
  const out: ReportResponse = { ok: true, blocked }
  return json(request, env, out)
}

async function blocks(
  request: Request,
  env: Env,
  player: Player,
  rawName: string | null,
): Promise<Response> {
  if (request.method !== 'GET') {
    const body = (await readJson(request, 1024)) as { name?: unknown } | undefined
    const target = await accountByName(env, rawName ?? body?.name)
    if (!target) {
      return error(request, env, 404, 'No gunslinger by that name.')
    }
    if (target.id === player.accountId) {
      return error(request, env, 400, "You can't block yourself.")
    }
    if (request.method === 'DELETE') {
      await unblock(env, player.accountId, target.id)
    } else if (!(await block(env, { blockerId: player.accountId, targetId: target.id }))) {
      return error(request, env, 409, 'Your block list is full.')
    }
  }
  const out: BlocksResponse = { ok: true, blocked: await blockedNames(env, player.accountId) }
  return json(request, env, out)
}

async function signedIn(
  request: Request,
  env: Env,
  then: (player: Player) => Promise<Response>,
): Promise<Response> {
  const player = await authenticate(request, env)
  return player ? then(player) : error(request, env, 401, SIGN_IN)
}

export const socialRoutes: RouteHandler = async (request, env, url) => {
  const path = url.pathname
  const method = request.method
  if (path === '/board/most-wanted' && method === 'GET') {
    return board(request, env, url)
  }
  if (path === '/saloon/chalkboard' && method === 'GET') {
    const out: ChalkboardResponse = { rounds: await chalkboard(env) }
    return json(request, env, out, 200, { 'Cache-Control': 'public, max-age=30' })
  }
  if (path === '/saloon/round' && method === 'POST') {
    return signedIn(request, env, (p) => round(request, env, p))
  }
  if (path === '/reports' && method === 'POST') {
    return signedIn(request, env, (p) => report(request, env, p))
  }
  const blockName = BLOCK_PATH.exec(path)?.groups?.name
  if (path === '/blocks' || (blockName && method === 'DELETE')) {
    if (!['GET', 'POST', 'DELETE'].includes(method)) {
      return null
    }
    return signedIn(request, env, (p) =>
      blocks(request, env, p, blockName ? decode(blockName) : null),
    )
  }
  const playerName = PLAYER_PATH.exec(path)?.groups?.name
  if (playerName && method === 'GET') {
    const viewer = await authenticate(request, env)
    const poster = await playerPoster(env, decode(playerName), viewer?.accountId ?? null)
    if (!poster) {
      return error(request, env, 404, 'No gunslinger by that name.')
    }
    return json(request, env, poster, 200, {
      'Cache-Control': viewer ? 'private, no-store' : 'public, max-age=30',
    })
  }
  return null
}
