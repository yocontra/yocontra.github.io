/**
 * Rotating refresh tokens. One family per sign-in. Each use rotates the token. Presenting an
 * already-rotated token revokes the whole family (theft detection), except in two benign cases:
 *
 * - **Lost response (replay).** The server rotated and committed, but the client never stored the
 *   new token: the page unloaded or reloaded (an HMR full reload, a navigation) while the refresh
 *   was in flight, so the browser dropped the response and its `Set-Cookie`. The client still
 *   holds the old token, and before this rule every later use of it was either `raced` (inside the
 *   grace) or theft (after it), so the player was signed out for nothing. Now the rotation is
 *   idempotent per (old token, client) for `REPLAY_WINDOW_MS`: presenting the old token again hands
 *   back the *same* successor, re-derived, as long as nobody has used that successor yet.
 * - **Race.** Two tabs rotating the same token: the loser is told to retry (409), because by then
 *   the cookie jar holds the winner's token.
 *
 * Why replay and not "commit on acknowledgement" or a longer grace: an acknowledgement needs a
 * second round trip that can be lost in exactly the same way, and a longer grace alone doesn't
 * help, since it only ever answers 409 and never hands the client a token it can use.
 *
 * Why it doesn't weaken theft detection: the successor is `HMAC(AUTH_SECRET, old token + client
 * binding)`, so nothing secret is stored and there is still exactly one live token per family. A
 * replay needs all of these:
 * 1. the same client binding (IP and User-Agent) as the request that rotated;
 * 2. a successor that has never been used or revoked (once the real client uses it, the old token
 *    is stale and the old rules apply);
 * 3. a request within `REPLAY_WINDOW_MS` of the rotation.
 *
 * A thief elsewhere who presents a stale token still revokes the family. A thief who stole the
 * *current* token and rotates first still forks the family, and the real client's next refresh,
 * from its own binding, derives a successor that doesn't exist, so that is caught as reuse as before.
 *
 * Only SHA-256 hashes are stored. Owned by stream A.
 */
import {
  type ClientPlatform,
  type Player,
  REFRESH_TTL_MS,
} from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import { bytesToB64url, hmacSign, randomToken, sha256Hex } from './crypto.ts'

/** A rotated token presented again within this window is a benign race, not a theft. */
export const ROTATION_GRACE_MS = 10_000
/**
 * A rotated token whose successor was never used, presented again by the same client within this
 * window, gets that same successor back (a lost response). Long enough to cover a reload, a crash
 * and restore or a flaky network retry, but short next to the 15-minute access token.
 */
export const REPLAY_WINDOW_MS = 2 * 60_000

/** The successor of `presented` for `client`: deterministic, so a lost rotation can be replayed. */
async function successorOf(env: Env, presented: string, client: string): Promise<string> {
  return bytesToB64url(await hmacSign(env.AUTH_SECRET, `rt-next:v1:${client}:${presented}`))
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/u

export interface SessionGrant {
  refreshToken: string
  familyId: string
  platform: ClientPlatform
  authTime: number
  player: Player
}

export type RotateResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' | 'raced' | 'platform' }

export interface SessionStart {
  player: Player
  platform: ClientPlatform
  /** Epoch ms of the passkey ceremony behind this session. */
  authTime: number
}

/** Starts a new session family after a passkey ceremony (or an app code exchange). */
export async function startSession(
  env: Env,
  { player, platform, authTime }: SessionStart,
  now = Date.now(),
): Promise<SessionGrant> {
  const refreshToken = randomToken(32)
  const familyId = randomToken()
  const hash = await sha256Hex(refreshToken)
  await env.DB.prepare(
    `INSERT INTO refresh_tokens
       (id, account_id, family_id, token_hash, platform, auth_time, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomToken(),
      player.accountId,
      familyId,
      hash,
      platform,
      authTime,
      now,
      now + REFRESH_TTL_MS,
    )
    .run()
  return { refreshToken, familyId, platform, authTime, player }
}

interface TokenRow {
  id: string
  account_id: string
  family_id: string
  platform: ClientPlatform
  auth_time: number
  expires_at: number
  rotated_at: number | null
  revoked_at: number | null
  name: string | null
}

async function revokeFamily(env: Env, familyId: string, now: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
  )
    .bind(now, familyId)
    .run()
}

function rejectRow(row: TokenRow, platform: ClientPlatform, now: number): RotateResult | null {
  if (row.revoked_at !== null || row.name === null) {
    return { ok: false, reason: 'revoked' }
  }
  if (row.platform !== platform) {
    return { ok: false, reason: 'platform' }
  }
  if (row.expires_at <= now) {
    return { ok: false, reason: 'expired' }
  }
  return null
}

function grantOf(row: TokenRow, refreshToken: string): RotateResult {
  return {
    ok: true,
    grant: {
      refreshToken,
      familyId: row.family_id,
      platform: row.platform,
      authTime: row.auth_time,
      player: { accountId: row.account_id, name: row.name ?? '' },
    },
  }
}

/** The lost-response case: the unused successor this client was already given, if any. */
async function replay(
  env: Env,
  row: TokenRow,
  successor: string,
  now: number,
): Promise<RotateResult | null> {
  if (row.rotated_at === null || now - row.rotated_at > REPLAY_WINDOW_MS) {
    return null
  }
  const unused = await env.DB.prepare(
    `SELECT 1 AS ok FROM refresh_tokens
     WHERE token_hash = ? AND family_id = ? AND rotated_at IS NULL AND revoked_at IS NULL
       AND expires_at > ?`,
  )
    .bind(await sha256Hex(successor), row.family_id, now)
    .first<{ ok: number }>()
  return unused ? grantOf(row, successor) : null
}

export interface RotateOptions {
  now?: number
  /** Who is rotating (see the module comment); routes pass a hash of IP and User-Agent. */
  client?: string
}

/**
 * Exchanges a refresh token for a new one in the same family. `client` binds the rotation to the
 * caller, so only that caller can replay it.
 */
export async function rotateSession(
  env: Env,
  presented: string,
  platform: ClientPlatform,
  { now = Date.now(), client = '' }: RotateOptions = {},
): Promise<RotateResult> {
  if (!TOKEN_SHAPE.test(presented)) {
    return { ok: false, reason: 'unknown' }
  }
  const hash = await sha256Hex(presented)
  const row = await env.DB.prepare(
    `SELECT t.id, t.account_id, t.family_id, t.platform, t.auth_time, t.expires_at,
            t.rotated_at, t.revoked_at, a.name
     FROM refresh_tokens t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.token_hash = ?`,
  )
    .bind(hash)
    .first<TokenRow>()
  if (!row) {
    return { ok: false, reason: 'unknown' }
  }
  const rejected = rejectRow(row, platform, now)
  if (rejected) {
    return rejected
  }
  const refreshToken = await successorOf(env, presented, client)
  if (row.rotated_at !== null) {
    const replayed = await replay(env, row, refreshToken, now)
    if (replayed) {
      return replayed
    }
    if (now - row.rotated_at <= ROTATION_GRACE_MS) {
      return { ok: false, reason: 'raced' }
    }
    await revokeFamily(env, row.family_id, now)
    return { ok: false, reason: 'reused' }
  }
  // The UPDATE only matches an unrotated row, and the INSERT only runs when that UPDATE changed it
  // (`changes()` is the previous statement's count inside the batch), so of two concurrent
  // rotations exactly one inserts, even within the same millisecond.
  const [claimed] = await env.DB.batch([
    env.DB.prepare(
      'UPDATE refresh_tokens SET rotated_at = ? WHERE id = ? AND rotated_at IS NULL',
    ).bind(now, row.id),
    env.DB.prepare(
      `INSERT INTO refresh_tokens
         (id, account_id, family_id, token_hash, platform, auth_time, created_at, expires_at)
       SELECT ?, account_id, family_id, ?, platform, auth_time, ?, ?
       FROM refresh_tokens WHERE id = ? AND rotated_at = ? AND changes() = 1`,
    ).bind(randomToken(), await sha256Hex(refreshToken), now, now + REFRESH_TTL_MS, row.id, now),
  ])
  if (claimed?.meta.changes !== 1) {
    // Lost the race. From the same client the winner minted this very successor: hand it over.
    return (
      (await replay(env, { ...row, rotated_at: now }, refreshToken, now)) ?? {
        ok: false,
        reason: 'raced',
      }
    )
  }
  return grantOf(row, refreshToken)
}

/** Revokes the family a refresh token belongs to (logout). Unknown tokens are ignored. */
export async function endSession(env: Env, presented: string, now = Date.now()): Promise<void> {
  if (!TOKEN_SHAPE.test(presented)) {
    return
  }
  const hash = await sha256Hex(presented)
  const row = await env.DB.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ family_id: string }>()
  if (row) {
    await revokeFamily(env, row.family_id, now)
  }
}

/** Revokes a session family by id (logout with only a bearer token). */
export async function endFamily(
  env: Env,
  accountId: string,
  familyId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE refresh_tokens SET revoked_at = ?
     WHERE family_id = ? AND account_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, familyId, accountId)
    .run()
}
