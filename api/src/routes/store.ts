/**
 * The Outfitter: catalog and purchases. Owned by stream C.
 *   GET  /store        → StoreResponse (signed out: owned = [], purse/level = null)
 *   POST /store/buy    { itemId } → BuyResponse
 *   POST /store/dye    { itemId, dye, requestId? } → DyeResponse  (contract/economy.ts)
 *
 * A purchase is one batch: the ledger debit (idem key `buy:<acct>:<item>`) plus the inventory row.
 * An overdraft fails the purse CHECK and a duplicate item fails the inventory primary key, and
 * either rolls the whole batch back. A replay of the same purchase is a no-op.
 */
import type {
  BuyResponse,
  DyeResponse,
  StoreResponse,
} from '../../../src/experiments/out-west/contract/economy.ts'
import {
  CATALOG,
  CATALOG_VERSION,
  canBuy,
  type ItemId,
  isItemId,
  itemById,
} from '../../../src/experiments/out-west/data/catalog.ts'
import {
  canDye,
  type DyeId,
  type DyeVerdict,
  dyePrice,
  isDyeId,
} from '../../../src/experiments/out-west/data/dye.ts'
import { authenticate, type Player } from '../economy/auth.ts'
import { isConstraintError, isOverdraft, ledgerStatements } from '../economy/ledger.ts'
import { getProfileDetail, ownedItems } from '../economy/profile.ts'
import { dyeStatements, dyesOf, requestIdOf } from '../economy/sinks.ts'
import type { Env } from '../env.ts'
import { BODY_TINY, error, json, type RouteHandler, readObject } from '../http.ts'

const REFUSALS: Record<string, [number, string]> = {
  not_for_sale: [403, "That one isn't for sale."],
  owned: [409, 'You already own that.'],
  level: [403, 'Your level is too low for that.'],
  funds: [402, "You can't afford that."],
}

/** Statements for one purchase. Exported for tests and for future bundles. */
export function purchaseStatements(
  env: Env,
  accountId: string,
  itemId: ItemId,
  price: number,
): D1PreparedStatement[] {
  const key = `buy:${accountId}:${itemId}`
  return [
    ...ledgerStatements(env, key, [
      { accountId, kind: 'store_purchase', amount: -price, ref: itemId },
    ]),
    // Plain INSERT: owning the item by any other route fails the primary key and aborts the batch.
    // A replay of this exact purchase (same ref) inserts nothing.
    env.DB.prepare(
      `INSERT INTO inventory (account_id, item_id, source, ref, acquired_at)
       SELECT ?1, ?2, 'store', ?3, ?4
       WHERE NOT EXISTS (SELECT 1 FROM inventory WHERE account_id = ?1 AND item_id = ?2 AND ref = ?3)`,
    ).bind(accountId, itemId, `${key}#0`, Date.now()),
  ]
}

async function buy(request: Request, env: Env, player: Player): Promise<Response> {
  const body = await readObject(request, BODY_TINY)
  const itemId = body.itemId
  const item = isItemId(itemId) ? itemById(itemId) : undefined
  if (!(isItemId(itemId) && item)) {
    return error(request, env, 400, 'Unknown item.')
  }
  const profile = await getProfileDetail(env, player.accountId)
  if (!profile) {
    return error(request, env, 404, 'No profile.')
  }
  const owned = new Set<string>(await ownedItems(env, player.accountId))
  const verdict = canBuy(profile, item, owned)
  const refusal = REFUSALS[verdict]
  if (refusal) {
    return error(request, env, refusal[0], refusal[1])
  }
  try {
    await env.DB.batch(purchaseStatements(env, player.accountId, itemId, item.price))
  } catch (err) {
    if (isOverdraft(err)) {
      return error(request, env, 402, "You can't afford that.")
    }
    if (isConstraintError(err)) {
      return error(request, env, 409, 'You already own that.')
    }
    throw err
  }
  const after = await getProfileDetail(env, player.accountId)
  const response: BuyResponse = {
    ok: true,
    itemId,
    purse: after?.purse ?? 0,
    owned: await ownedItems(env, player.accountId),
  }
  return json(request, env, response)
}

const DYE_REFUSALS: Record<Exclude<DyeVerdict, 'ok'>, [number, string]> = {
  not_dyeable: [400, "That one doesn't take dye."],
  not_owned: [403, "You don't own that."],
  same: [409, "It's already that colour."],
  funds: [402, "You can't afford that dye job."],
}

async function currentDye(env: Env, accountId: string, itemId: ItemId): Promise<DyeId | null> {
  const row = await env.DB.prepare('SELECT dye FROM inventory WHERE account_id = ? AND item_id = ?')
    .bind(accountId, itemId)
    .first<{ dye: string | null }>()
  return isDyeId(row?.dye) ? row.dye : null
}

/** `POST /store/dye`: recolour an owned item (§5 dye jobs). One guarded batch. */
async function dye(request: Request, env: Env, player: Player): Promise<Response> {
  const body = await readObject(request, BODY_TINY)
  const itemId = body.itemId
  const wanted = body.dye
  if (!(isItemId(itemId) && isDyeId(wanted))) {
    return error(request, env, 400, 'Unknown item or dye.')
  }
  const profile = await getProfileDetail(env, player.accountId)
  if (!profile) {
    return error(request, env, 404, 'No profile.')
  }
  const owned = new Set<string>(await ownedItems(env, player.accountId))
  const current = await currentDye(env, player.accountId, itemId)
  const verdict = canDye({ itemId, dye: wanted, owned, current, purse: profile.purse })
  if (verdict !== 'ok') {
    const [status, message] = DYE_REFUSALS[verdict]
    return error(request, env, status, message)
  }
  const price = dyePrice(itemId, wanted) ?? 0
  const requestId = requestIdOf(body.requestId)
  try {
    await env.DB.batch(
      dyeStatements(env, {
        accountId: player.accountId,
        itemId,
        dye: wanted,
        current,
        price,
        requestId,
      }),
    )
  } catch (err) {
    if (isOverdraft(err)) {
      return error(request, env, 402, DYE_REFUSALS.funds[1])
    }
    // The guard failed: the dye changed under us (a retry that already landed, or a race).
    if (!(isConstraintError(err) && (await currentDye(env, player.accountId, itemId)) === wanted)) {
      throw err
    }
  }
  const after = await getProfileDetail(env, player.accountId)
  const response: DyeResponse = {
    ok: true,
    itemId,
    dye: wanted,
    price,
    purse: after?.purse ?? 0,
    dyes: await dyesOf(env, player.accountId),
  }
  return json(request, env, response)
}

async function catalog(request: Request, env: Env): Promise<Response> {
  const player = await authenticate(request, env)
  const profile = player ? await getProfileDetail(env, player.accountId) : null
  const body: StoreResponse = {
    catalogVersion: CATALOG_VERSION,
    items: CATALOG,
    owned: profile ? await ownedItems(env, profile.accountId) : [],
    purse: profile?.purse ?? null,
    level: profile?.level ?? null,
  }
  return json(request, env, body, 200, {
    'Cache-Control': player ? 'private, no-store' : 'public, max-age=300',
  })
}

export const storeRoutes: RouteHandler = async (request, env, url) => {
  if (url.pathname === '/store' && request.method === 'GET') {
    return catalog(request, env)
  }
  if (
    (url.pathname === '/store/buy' || url.pathname === '/store/dye') &&
    request.method === 'POST'
  ) {
    const player = await authenticate(request, env)
    if (!player) {
      return error(request, env, 401, 'Sign in first.')
    }
    return url.pathname === '/store/buy' ? buy(request, env, player) : dye(request, env, player)
  }
  return null
}
