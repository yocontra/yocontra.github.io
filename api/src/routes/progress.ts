/**
 * The solo meta-game on the account (meta-game stream): medals and challenges, the guest purse's
 * migration, claimed hat shots and the Legend cosmetics. Contract: `contract/meta.ts`.
 *   GET  /progress           → ProgressResponse
 *   POST /progress/migrate   { claim } → MigrateResponse   (once per account, capped)
 *   POST /progress/claim     { challengeId, runId } → ClaimResponse
 *   POST /progress/legend    { beaten } → ProgressResponse
 */
import type {
  ClaimResponse,
  MigrateResponse,
  ProgressResponse,
} from '../../../src/experiments/out-west/contract/meta.ts'
import {
  type GuestClaim,
  guestCredit,
  OUTLAW_COUNT,
  SOLO_REWARDS,
} from '../../../src/experiments/out-west/data/medals.ts'
import { authenticate, type Player } from '../economy/auth.ts'
import { FULL_CLEAR_MASK } from '../economy/gauntlet.ts'
import { isConstraintError, ledgerStatements } from '../economy/ledger.ts'
import { claimStatements, dailyWinsOf, marksOf } from '../economy/medals.ts'
import { getProfileDetail, ownedItems } from '../economy/profile.ts'
import type { Env } from '../env.ts'
import { error, json, type RouteHandler, readJson } from '../http.ts'

const REWARD_ITEMS = new Set(SOLO_REWARDS.map((r) => r.item))

/** A device's claim, made safe: at most 17 marks of tier 0..3, a 17-bit clear mask. */
export function sanitizeClaim(value: unknown): GuestClaim | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const v = value as { marks?: unknown; clears?: unknown }
  if (!Array.isArray(v.marks) || v.marks.length > OUTLAW_COUNT) {
    return null
  }
  const clears = typeof v.clears === 'number' && Number.isInteger(v.clears) ? v.clears : 0
  const marks = v.marks.map((m: unknown) => {
    const r = (typeof m === 'object' && m !== null ? m : {}) as {
      tier?: unknown
      challenge?: unknown
    }
    const tier = typeof r.tier === 'number' && Number.isInteger(r.tier) ? r.tier : 0
    return { tier: Math.min(3, Math.max(0, tier)), challenge: r.challenge === true }
  })
  return { marks, clears: clears & FULL_CLEAR_MASK }
}

async function progress(env: Env, accountId: string): Promise<ProgressResponse | null> {
  const detail = await getProfileDetail(env, accountId)
  if (!detail) {
    return null
  }
  const [marks, dailyWins, owned, migration] = await Promise.all([
    marksOf(env, accountId),
    dailyWinsOf(env, accountId),
    ownedItems(env, accountId),
    env.DB.prepare('SELECT xp, cash, created_at FROM guest_migrations WHERE account_id = ?')
      .bind(accountId)
      .first<{ xp: number; cash: number; created_at: number }>(),
  ])
  return {
    marks,
    dailyWins,
    rewards: owned.filter((i) => REWARD_ITEMS.has(i)),
    migration: migration ? { xp: migration.xp, cash: migration.cash, at: migration.created_at } : null,
    storeLevel: detail.storeLevel,
  }
}

async function migrate(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 8 * 1024)) as { claim?: unknown } | undefined
  const claim = sanitizeClaim(body?.claim)
  if (!claim) {
    return error(request, env, 400, 'That guest purse doesn’t read right.')
  }
  const id = player.accountId
  const done = await env.DB.prepare('SELECT 1 AS yes FROM guest_migrations WHERE account_id = ?')
    .bind(id)
    .first<{ yes: number }>()
  if (done) {
    return error(request, env, 409, 'Your guest purse already rode in with you.')
  }
  const credit = guestCredit(claim)
  const now = Date.now()
  try {
    await env.DB.batch([
      // first, so a second migration fails on the primary key and books nothing
      env.DB.prepare(
        `INSERT INTO guest_migrations
           (account_id, claimed_xp, claimed_cash, xp, cash, claim, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        credit.raw.xp,
        credit.raw.cash,
        credit.xp,
        credit.cash,
        JSON.stringify(claim),
        now,
      ),
      ...ledgerStatements(env, `guest:${id}`, [
        { accountId: id, kind: 'guest_migration', amount: credit.cash, xp: credit.xp, ref: 'guest' },
      ]),
    ])
  } catch (err) {
    if (isConstraintError(err)) {
      return error(request, env, 409, 'Your guest purse already rode in with you.')
    }
    throw err
  }
  const after = await getProfileDetail(env, id)
  const out: MigrateResponse = {
    ok: true,
    xp: credit.xp,
    cash: credit.cash,
    claimed: credit.raw,
    purse: after?.purse ?? 0,
    level: after?.level ?? 1,
  }
  return json(request, env, out)
}

const CLAIM_REFUSALS = {
  unknown: [400, 'No such challenge.'],
  // biome-ignore lint/style/useNamingConvention: refusal codes from economy/medals.ts
  not_claim: [400, 'That challenge is judged by the server, not claimed.'],
  // biome-ignore lint/style/useNamingConvention: refusal codes from economy/medals.ts
  no_win: [403, 'Beat him on a ranked run first, then claim it.'],
  done: [409, 'You already have that one.'],
} as const

async function claim(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 1024)) as
    | { challengeId?: unknown; runId?: unknown }
    | undefined
  const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : ''
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const r = await claimStatements(env, player.accountId, challengeId, runId)
  if (typeof r === 'string') {
    const [status, message] = CLAIM_REFUSALS[r]
    return error(request, env, status, message)
  }
  await env.DB.batch(r.statements)
  const out: ClaimResponse = { ok: true, challengeId, xp: r.xp, granted: r.granted }
  return json(request, env, out)
}

/** Legend items: claimed from the device, only by an account that cleared the gauntlet ranked. */
async function legend(request: Request, env: Env, player: Player): Promise<Response> {
  const body = (await readJson(request, 1024)) as { beaten?: unknown } | undefined
  const beaten = typeof body?.beaten === 'number' && Number.isInteger(body.beaten) ? body.beaten : -1
  if (beaten < 0 || beaten > OUTLAW_COUNT) {
    return error(request, env, 400, 'beaten must be 0–17.')
  }
  const detail = await getProfileDetail(env, player.accountId)
  if (!detail) {
    return error(request, env, 404, 'No profile.')
  }
  if ((detail.gauntletClears & FULL_CLEAR_MASK) !== FULL_CLEAR_MASK) {
    return error(request, env, 403, 'Clear the whole gauntlet on a ranked run first.')
  }
  const now = Date.now()
  const items = SOLO_REWARDS.filter((r) => r.rule.kind === 'legend' && beaten >= r.rule.beaten)
  if (items.length > 0) {
    await env.DB.batch(
      items.map((r) =>
        env.DB.prepare(
          `INSERT INTO inventory (account_id, item_id, source, acquired_at) VALUES (?, ?, 'reward', ?)
           ON CONFLICT (account_id, item_id) DO NOTHING`,
        ).bind(player.accountId, r.item, now),
      ),
    )
  }
  const out = await progress(env, player.accountId)
  return out ? json(request, env, out) : error(request, env, 404, 'No profile.')
}

export const progressRoutes: RouteHandler = async (request, env, url) => {
  if (!url.pathname.startsWith('/progress')) {
    return null
  }
  const player = await authenticate(request, env)
  if (!player) {
    return error(request, env, 401, 'Sign in first.')
  }
  const key = `${request.method} ${url.pathname}`
  switch (key) {
    case 'GET /progress': {
      const out = await progress(env, player.accountId)
      return out ? json(request, env, out) : error(request, env, 404, 'No profile.')
    }
    case 'POST /progress/migrate':
      return await migrate(request, env, player)
    case 'POST /progress/claim':
      return await claim(request, env, player)
    case 'POST /progress/legend':
      return await legend(request, env, player)
    default:
      return error(request, env, 404, 'Not found.')
  }
}
