/**
 * Account rows: name reservation at sign-up, creation with the first passkey, lookup, and hard
 * deletion. Owned by stream A.
 */
import {
  CHALLENGE_TTL_MS,
  NAME_RELEASE_MS,
  type PasskeyInfo,
} from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import { creationStatements, deletionStatements } from './hooks.ts'

/**
 * True when an account holds this name key: its current name, a recently deleted account's, or one
 * an account gave up in a name change in the last 30 days. For sign-up and the ranked flow.
 */
export async function isNameOwned(env: Env, nameKey: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS taken FROM accounts WHERE name_key = ?1
     UNION ALL SELECT 1 FROM name_tombstones WHERE name_key = ?1 AND released_at > ?2
     UNION ALL SELECT 1 FROM name_holds WHERE name_key = ?1 AND released_at > ?2
     LIMIT 1`,
  )
    .bind(nameKey, now)
    .first<{ taken: number }>()
  return row !== null
}

/**
 * Holds a name for this client for 5 minutes while the passkey ceremony runs. The same client may
 * re-reserve (a cancelled prompt and a retry); anyone else is refused until it expires.
 */
export async function reserveName(
  env: Env,
  {
    nameKey,
    challengeId,
    clientHash,
  }: { nameKey: string; challengeId: string; clientHash: string },
  now = Date.now(),
): Promise<boolean> {
  if (await isNameOwned(env, nameKey, now)) {
    return false
  }
  const row = await env.DB.prepare(
    `INSERT INTO name_reservations (name_key, challenge_id, client_hash, expires_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (name_key) DO UPDATE SET
       challenge_id = excluded.challenge_id, client_hash = excluded.client_hash,
       expires_at = excluded.expires_at
     WHERE name_reservations.expires_at <= ?5 OR name_reservations.client_hash = excluded.client_hash
     RETURNING challenge_id`,
  )
    .bind(nameKey, challengeId, clientHash, now + CHALLENGE_TTL_MS, now)
    .first<{ challenge_id: string }>()
  return row?.challenge_id === challengeId
}

export interface NewPasskey {
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
  aaguid: string
  deviceType: string
  backedUp: boolean
}

export function insertPasskey(
  env: Env,
  accountId: string,
  key: NewPasskey,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, aaguid,
       device_type, backed_up, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    key.credentialId,
    accountId,
    key.publicKey,
    key.counter,
    JSON.stringify(key.transports),
    key.aaguid,
    key.deviceType,
    key.backedUp ? 1 : 0,
    now,
    now,
  )
}

/**
 * Creates the account, its first passkey and its wallet in one batch, but only while this ceremony still holds
 * the name reservation. Returns false if the name was lost (taken or the reservation expired).
 */
export async function createAccount(
  env: Env,
  input: { accountId: string; name: string; nameKey: string; challengeId: string; key: NewPasskey },
  now = Date.now(),
): Promise<boolean> {
  const { accountId, name, nameKey, challengeId, key } = input
  try {
    const [created] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, name, name_key, created_at)
         SELECT ?1, ?2, ?3, ?4 FROM name_reservations
         WHERE name_key = ?3 AND challenge_id = ?5 AND expires_at > ?4`,
      ).bind(accountId, name, nameKey, now, challengeId),
      // Fails the FK (and so the whole batch) when the account insert above matched nothing.
      insertPasskey(env, accountId, key, now),
      env.DB.prepare('DELETE FROM name_reservations WHERE name_key = ?').bind(nameKey),
      // The wallet (stream C); its FK to accounts also fails the batch if the account wasn't made.
      ...creationStatements(env, accountId),
    ])
    return created?.meta.changes === 1
  } catch (err) {
    console.warn('createAccount failed', err)
    return false
  }
}

export async function accountName(env: Env, accountId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT name FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ name: string }>()
  return row?.name ?? null
}

interface PasskeyRow {
  credential_id: string
  label: string | null
  created_at: number
  last_used_at: number | null
  backed_up: number
}

export async function listPasskeys(env: Env, accountId: string): Promise<PasskeyInfo[]> {
  const { results } = await env.DB.prepare(
    `SELECT credential_id, label, created_at, last_used_at, backed_up
     FROM passkeys WHERE account_id = ? ORDER BY created_at`,
  )
    .bind(accountId)
    .all<PasskeyRow>()
  return results.map((r) => ({
    id: r.credential_id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    backedUp: r.backed_up === 1,
  }))
}

/** Removes one passkey, never the last. Returns false if it isn't theirs or is the only one. */
export async function removePasskey(
  env: Env,
  accountId: string,
  credentialId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM passkeys WHERE credential_id = ?1 AND account_id = ?2
     AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?2) > 1`,
  )
    .bind(credentialId, accountId)
    .run()
  return res.meta.changes === 1
}

/**
 * Hard-deletes the account. Passkeys, refresh tokens, tickets, app codes and (via stream C's
 * cascades) the profile, ledger and inventory go with the row; stream B's statements anonymise
 * matches in the same batch. The name is tombstoned for 30 days.
 */
export async function deleteAccount(
  env: Env,
  accountId: string,
  now = Date.now(),
): Promise<boolean> {
  const results = await env.DB.batch([
    ...deletionStatements(env, accountId),
    env.DB.prepare(
      `INSERT INTO name_tombstones (name_key, released_at)
       SELECT name_key, ? FROM accounts WHERE id = ?
       ON CONFLICT (name_key) DO UPDATE SET released_at = excluded.released_at`,
    ).bind(now + NAME_RELEASE_MS, accountId),
    // Names it gave up in name changes stay unavailable until their own hold runs out.
    env.DB.prepare(
      `INSERT INTO name_tombstones (name_key, released_at)
       SELECT name_key, released_at FROM name_holds WHERE account_id = ? AND released_at > ?
       ON CONFLICT (name_key) DO UPDATE SET released_at = MAX(released_at, excluded.released_at)`,
    ).bind(accountId, now),
    // Our own tables are cleared explicitly too, so deletion never depends on FK enforcement.
    ...['passkeys', 'refresh_tokens', 'ws_tickets', 'app_auth_codes', 'webauthn_challenges'].map(
      (table) => env.DB.prepare(`DELETE FROM ${table} WHERE account_id = ?`).bind(accountId),
    ),
    env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
  ])
  return results.at(-1)?.meta.changes === 1
}
