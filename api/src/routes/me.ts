/**
 * The signed-in player's wallet, XP, level, loadout and ledger. Owned by stream C.
 *   GET  /me                 → MeResponse
 *   GET  /me/ledger?limit=   → LedgerResponse (newest first)
 *   PUT  /me/loadout         { loadout } → { loadout }   (only owned items, right slots)
 *   POST /me/prestige        → MeResponse                (L50, prestige < 5)
 */
import type {
  LedgerKind,
  LedgerResponse,
  LoadoutResponse,
  MeResponse,
} from '../../../src/experiments/out-west/contract/economy.ts'
import { type Loadout, loadoutError } from '../../../src/experiments/out-west/data/catalog.ts'
import {
  baseBounty,
  canPrestige,
  levelProgress,
  titleFor,
} from '../../../src/experiments/out-west/data/progression.ts'
import { authenticate, type Player } from '../economy/auth.ts'
import { createProfile, getProfileDetail, ownedItems } from '../economy/profile.ts'
import type { Env } from '../env.ts'
import { error, json, type RouteHandler, readJson } from '../http.ts'

const DEFAULT_LEDGER_LIMIT = 50
const MAX_LEDGER_LIMIT = 200

/** The profile for a signed-in player, created on first sight (stream A normally does it). */
async function profileFor(env: Env, player: Player) {
  const detail = await getProfileDetail(env, player.accountId)
  if (detail) {
    return detail
  }
  await createProfile(env, player.accountId, player.name)
  return getProfileDetail(env, player.accountId)
}

export async function meResponse(env: Env, player: Player): Promise<MeResponse | null> {
  const detail = await profileFor(env, player)
  if (!detail) {
    return null
  }
  const progress = levelProgress(detail.xp)
  return {
    ...detail,
    title: titleFor(detail.level),
    bounty: baseBounty(detail.level, detail.prestige),
    xpInto: progress.into,
    xpNext: progress.next,
    owned: await ownedItems(env, player.accountId),
  }
}

interface LedgerDbRow {
  id: number
  kind: LedgerKind
  delta: number
  xp: number
  balance_after: number
  ref: string | null
  created_at: number
}

async function ledger(env: Env, accountId: string, url: URL): Promise<LedgerResponse> {
  const asked = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(asked)
    ? Math.min(MAX_LEDGER_LIMIT, Math.max(1, asked))
    : DEFAULT_LEDGER_LIMIT
  const { results } = await env.DB.prepare(
    `SELECT id, kind, delta, xp, balance_after, ref, created_at FROM ledger
     WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(accountId, limit)
    .all<LedgerDbRow>()
  return {
    entries: results.map((r) => ({
      id: r.id,
      kind: r.kind,
      amount: r.delta,
      xp: r.xp,
      balanceAfter: r.balance_after,
      ref: r.ref,
      createdAt: r.created_at,
    })),
  }
}

async function putLoadout(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 4 * 1024)) as { loadout?: unknown } | undefined
  const owned = new Set<string>(await ownedItems(env, player.accountId))
  const problem = loadoutError(body?.loadout, owned)
  if (problem) {
    return error(request, env, 400, problem)
  }
  const loadout = body?.loadout as Loadout
  const clean: Loadout = { ...loadout, extra: loadout.extra ?? null }
  await env.DB.prepare(
    'UPDATE profiles SET loadout = ?, version = version + 1, updated_at = ? WHERE account_id = ?',
  )
    .bind(JSON.stringify(clean), Date.now(), player.accountId)
    .run()
  return json(request, env, { loadout: clean } satisfies LoadoutResponse)
}

async function prestige(request: Request, env: Env, player: Player): Promise<Response> {
  const detail = await profileFor(env, player)
  if (!(detail && canPrestige(detail.level, detail.prestige))) {
    return error(request, env, 409, 'Reach level 50 to ride again.')
  }
  await env.DB.prepare(
    `UPDATE profiles SET level = 1, xp = 0, prestige = prestige + 1, version = version + 1,
       updated_at = ? WHERE account_id = ? AND level = 50 AND prestige < 5`,
  )
    .bind(Date.now(), player.accountId)
    .run()
  return json(request, env, await meResponse(env, player))
}

export const meRoutes: RouteHandler = async (request, env, url) => {
  const path = url.pathname
  if (path !== '/me' && !path.startsWith('/me/')) {
    return null
  }
  const player = await authenticate(request, env)
  if (!player) {
    return error(request, env, 401, 'Sign in first, partner.')
  }
  const route = `${request.method} ${path}`
  switch (route) {
    case 'GET /me': {
      const me = await meResponse(env, player)
      return me ? json(request, env, me) : error(request, env, 404, 'No profile.')
    }
    case 'GET /me/ledger':
      return json(request, env, await ledger(env, player.accountId, url))
    case 'PUT /me/loadout':
      return putLoadout(request, env, player)
    case 'POST /me/prestige':
      return prestige(request, env, player)
    default:
      return error(request, env, 404, 'Not found.')
  }
}
