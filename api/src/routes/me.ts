/**
 * The signed-in player's wallet, XP, level, loadout and ledger. Owned by stream C.
 *   GET  /me                 → MeResponse
 *   GET  /me/ledger?limit=   → LedgerResponse (newest first)
 *   PUT  /me/loadout         { loadout } → { loadout }   (only owned items, right slots)
 *   POST /me/prestige        → MeResponse                (L50, prestige < 5)
 *   POST /me/name            { name } → NameChangeResponse ($5,000, once per 30 days)
 *   POST /me/away/ack        { asOf } → 204              (dismiss the "while you were away" notice)
 */
import type {
  AwayReport,
  LedgerKind,
  LedgerResponse,
  LoadoutResponse,
  MeResponse,
} from '../../../src/experiments/out-west/contract/economy.ts'
import type { NameChangeResponse } from '../../../src/experiments/out-west/contract/social.ts'
import { type Loadout, loadoutError } from '../../../src/experiments/out-west/data/catalog.ts'
import {
  baseBounty,
  canPrestige,
  levelProgress,
  titleFor,
} from '../../../src/experiments/out-west/data/progression.ts'
import {
  NAME_CHANGE_COOLDOWN_MS,
  NAME_CHANGE_PRICE,
} from '../../../src/experiments/out-west/data/sinks.ts'
import { authenticate, type Player } from '../economy/auth.ts'
import { rollover } from '../economy/board.ts'
import { isConstraintError, isOverdraft } from '../economy/ledger.ts'
import { createProfile, getProfileDetail, ownedItems } from '../economy/profile.ts'
import { dyesOf, nameChangeStatements, nameRefusal } from '../economy/sinks.ts'
import type { Env } from '../env.ts'
import { error, json, type RouteHandler, readJson } from '../http.ts'
import { validateName } from '../names.ts'

/** With no acknowledgement yet, the notice covers this far back. */
const AWAY_FIRST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const NAME_PRICE_COPY = `A new name costs $${NAME_CHANGE_PRICE.toLocaleString('en-US')}.`

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

/** Passive earnings since the player last dismissed the notice (§6 "while you were away"). */
export async function awayReport(
  env: Env,
  accountId: string,
  now = Date.now(),
): Promise<AwayReport> {
  const mark = await env.DB.prepare('SELECT away_seen_at FROM profiles WHERE account_id = ?')
    .bind(accountId)
    .first<{ away_seen_at: number | null }>()
  const since = mark?.away_seen_at ?? null
  const from = since ?? now - AWAY_FIRST_WINDOW_MS
  const [royalties, wanted] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS amount FROM ledger
       WHERE account_id = ?1 AND kind = 'ghost_royalty' AND created_at > ?2 AND created_at <= ?3`,
    ).bind(accountId, from, now),
    env.DB.prepare(
      `SELECT month, rank FROM most_wanted_winners
       WHERE account_id = ?1 AND awarded_at > ?2 AND awarded_at <= ?3 ORDER BY month`,
    ).bind(accountId, from, now),
  ])
  const r = (royalties?.results as { n: number; amount: number }[] | undefined)?.[0]
  const amount = r?.amount ?? 0
  return {
    since,
    asOf: now,
    royalties: { count: r?.n ?? 0, amount },
    mostWanted: (wanted?.results ?? []) as { month: string; rank: number }[],
    total: amount,
  }
}

export async function meResponse(env: Env, player: Player): Promise<MeResponse | null> {
  const detail = await profileFor(env, player)
  if (!detail) {
    return null
  }
  await rollover(env)
  const progress = levelProgress(detail.xp)
  const [owned, dyes, away] = await Promise.all([
    ownedItems(env, player.accountId),
    dyesOf(env, player.accountId),
    awayReport(env, player.accountId),
  ])
  return {
    ...detail,
    title: titleFor(detail.level),
    bounty: baseBounty(detail.level, detail.prestige),
    xpInto: progress.into,
    xpNext: progress.next,
    owned,
    dyes,
    away,
  }
}

async function awayAck(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 1024)) as { asOf?: unknown } | undefined
  const asked = body?.asOf
  if (typeof asked !== 'number' || !Number.isFinite(asked)) {
    return error(request, env, 400, 'asOf is required.')
  }
  const asOf = Math.min(Date.now(), Math.round(asked))
  await env.DB.prepare(
    'UPDATE profiles SET away_seen_at = MAX(COALESCE(away_seen_at, 0), ?) WHERE account_id = ?',
  )
    .bind(asOf, player.accountId)
    .run()
  const headers = json(request, env, null).headers
  headers.delete('Content-Type')
  return new Response(null, { status: 204, headers })
}

const NAME_REFUSALS = {
  same: [409, "That's already your name."],
  taken: [409, 'That name is taken. Pick another.'],
  cooldown: [429, 'You changed your name recently. Give it a while.'],
} as const

interface NameRow {
  name: string
  name_key: string
  name_changed_at: number | null
  purse: number
}

async function changeName(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 1024)) as { name?: unknown } | undefined
  const wanted = validateName(body?.name)
  if (!wanted.ok) {
    return error(request, env, 400, wanted.error)
  }
  const account = await env.DB.prepare(
    `SELECT a.name, a.name_key, a.name_changed_at, p.purse FROM accounts a
     JOIN profiles p ON p.account_id = a.id WHERE a.id = ?`,
  )
    .bind(player.accountId)
    .first<NameRow>()
  if (!account) {
    return error(request, env, 404, 'No profile.')
  }
  const now = Date.now()
  const refusal = await nameRefusal(
    env,
    {
      accountId: player.accountId,
      currentKey: account.name_key,
      newKey: wanted.key,
      changedAt: account.name_changed_at,
    },
    now,
  )
  if (refusal) {
    const [status, message] = NAME_REFUSALS[refusal.reason]
    const retryAfterS = refusal.retryAt ? Math.ceil((refusal.retryAt - now) / 1000) : undefined
    return json(request, env, { ok: false, error: message, retryAfterS }, status)
  }
  if (account.purse < NAME_CHANGE_PRICE) {
    return error(request, env, 402, NAME_PRICE_COPY)
  }
  const change = {
    accountId: player.accountId,
    oldName: account.name,
    oldKey: account.name_key,
    newName: wanted.name,
    newKey: wanted.key,
    changedAt: account.name_changed_at,
  }
  try {
    await env.DB.batch(nameChangeStatements(env, change, now))
  } catch (err) {
    if (isOverdraft(err)) {
      return error(request, env, 402, NAME_PRICE_COPY)
    }
    if (isConstraintError(err)) {
      return error(request, env, 409, NAME_REFUSALS.taken[1])
    }
    throw err
  }
  const after = await getProfileDetail(env, player.accountId)
  const out: NameChangeResponse = {
    ok: true,
    name: wanted.name,
    purse: after?.purse ?? 0,
    nextChangeAt: now + NAME_CHANGE_COOLDOWN_MS,
  }
  return json(request, env, out)
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
    case 'POST /me/name':
      return changeName(request, env, player)
    case 'POST /me/away/ack':
      return awayAck(request, env, player)
    default:
      return error(request, env, 404, 'Not found.')
  }
}
