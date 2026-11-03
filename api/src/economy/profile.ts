/**
 * Profiles: the wallet, XP, level, prestige and loadout of an account. Owned by stream C.
 * Deleting the account cascades to `profiles`, `ledger` and `inventory`; no extra hook is needed.
 */
import type { Profile as ContractProfile } from '../../../src/experiments/out-west/contract/economy.ts'
import {
  DEFAULT_LOADOUT,
  type ItemId,
  isItemId,
  normalizeLoadout,
  STARTER_ITEMS,
} from '../../../src/experiments/out-west/data/catalog.ts'
import { START_PURSE } from '../../../src/experiments/out-west/data/progression.ts'
import type { Env } from '../env.ts'
import { ledgerStatements } from './ledger.ts'

export type Profile = ContractProfile

interface ProfileRow {
  account_id: string
  name: string | null
  purse: number
  xp: number
  level: number
  prestige: number
  loadout: string
  gauntlet_clears: number
}

function parseLoadout(raw: string): Profile['loadout'] {
  try {
    return normalizeLoadout(JSON.parse(raw) as unknown)
  } catch {
    return normalizeLoadout(null)
  }
}

const SELECT_PROFILE = `SELECT p.account_id, a.name, p.purse, p.xp, p.level, p.prestige, p.loadout,
  p.gauntlet_clears
FROM profiles p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.account_id = ?`

/** A profile plus the extra columns the routes need. */
export interface ProfileDetail extends Profile {
  gauntletClears: number
}

export async function getProfileDetail(env: Env, accountId: string): Promise<ProfileDetail | null> {
  const row = await env.DB.prepare(SELECT_PROFILE).bind(accountId).first<ProfileRow>()
  if (!row) {
    return null
  }
  return {
    accountId: row.account_id,
    name: row.name ?? '',
    purse: row.purse,
    xp: row.xp,
    level: row.level,
    prestige: row.prestige,
    loadout: parseLoadout(row.loadout),
    gauntletClears: row.gauntlet_clears,
  }
}

export async function getProfile(env: Env, accountId: string): Promise<Profile | null> {
  const detail = await getProfileDetail(env, accountId)
  if (!detail) {
    return null
  }
  const { gauntletClears: _, ...profile } = detail
  return profile
}

/**
 * The statements that create a profile: the row, the eight starter items and the $250 start grant.
 * Idempotent, so a caller may include them in its own sign-up batch and retry freely.
 */
export function createProfileStatements(env: Env, accountId: string): D1PreparedStatement[] {
  const now = Date.now()
  const placeholders = STARTER_ITEMS.map(() => "(?, ?, 'starter', ?)").join(', ')
  return [
    env.DB.prepare(
      `INSERT INTO profiles (account_id, loadout, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id) DO NOTHING`,
    ).bind(accountId, JSON.stringify(DEFAULT_LOADOUT), now, now),
    env.DB.prepare(
      `INSERT INTO inventory (account_id, item_id, source, acquired_at) VALUES ${placeholders}
       ON CONFLICT (account_id, item_id) DO NOTHING`,
    ).bind(...STARTER_ITEMS.flatMap((id) => [accountId, id, now])),
    ...ledgerStatements(env, `start:${accountId}`, [
      { accountId, kind: 'start_grant', amount: START_PURSE, ref: 'start' },
    ]),
  ]
}

/**
 * Creates the profile with the start grant. Idempotent. Called by stream A after first sign-up,
 * once the `accounts` row exists. `name` is read from `accounts`; it is accepted for the contract.
 */
export async function createProfile(env: Env, accountId: string, name: string): Promise<Profile> {
  await env.DB.batch(createProfileStatements(env, accountId))
  const profile = await getProfile(env, accountId)
  if (!profile) {
    throw new Error(`createProfile: no profile for ${accountId}`)
  }
  return profile.name === '' ? { ...profile, name } : profile
}

/** Every item the account owns. */
export async function ownedItems(env: Env, accountId: string): Promise<ItemId[]> {
  const { results } = await env.DB.prepare(
    'SELECT item_id FROM inventory WHERE account_id = ? ORDER BY acquired_at, item_id',
  )
    .bind(accountId)
    .all<{ item_id: string }>()
  return results.map((r) => r.item_id).filter(isItemId)
}

/** Grants a non-store item (a gauntlet or cowardice reward). Idempotent. */
export function grantItemStatement(
  env: Env,
  accountId: string,
  itemId: ItemId,
  source: 'reward' | 'admin' = 'reward',
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO inventory (account_id, item_id, source, acquired_at)
     SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM profiles WHERE account_id = ?1)
     ON CONFLICT (account_id, item_id) DO NOTHING`,
  ).bind(accountId, itemId, source, Date.now())
}
