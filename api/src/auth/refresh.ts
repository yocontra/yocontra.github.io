/**
 * Rotating refresh tokens. One family per sign-in. Each use rotates the token. Presenting an
 * already-rotated token revokes the whole family (theft detection), except within a short grace
 * window, where it is treated as two tabs racing and the caller is told to retry. Only SHA-256
 * hashes are stored. Owned by stream A.
 */
import {
  type ClientPlatform,
  type Player,
  REFRESH_TTL_MS,
} from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import { randomToken, sha256Hex } from './crypto.ts'

/** A rotated token presented again within this window is a benign race, not a theft. */
export const ROTATION_GRACE_MS = 10_000

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

/** Exchanges a refresh token for a new one in the same family. */
export async function rotateSession(
  env: Env,
  presented: string,
  platform: ClientPlatform,
  now = Date.now(),
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
  if (row.rotated_at !== null) {
    if (now - row.rotated_at <= ROTATION_GRACE_MS) {
      return { ok: false, reason: 'raced' }
    }
    await revokeFamily(env, row.family_id, now)
    return { ok: false, reason: 'reused' }
  }
  const refreshToken = randomToken(32)
  const next = await sha256Hex(refreshToken)
  // The UPDATE only matches an unrotated row, so of two concurrent rotations exactly one inserts.
  const [claimed] = await env.DB.batch([
    env.DB.prepare(
      'UPDATE refresh_tokens SET rotated_at = ? WHERE id = ? AND rotated_at IS NULL',
    ).bind(now, row.id),
    env.DB.prepare(
      `INSERT INTO refresh_tokens
         (id, account_id, family_id, token_hash, platform, auth_time, created_at, expires_at)
       SELECT ?, account_id, family_id, ?, platform, auth_time, ?, ?
       FROM refresh_tokens WHERE id = ? AND rotated_at = ?`,
    ).bind(randomToken(), next, now, now + REFRESH_TTL_MS, row.id, now),
  ])
  if (claimed?.meta.changes !== 1) {
    return { ok: false, reason: 'raced' }
  }
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
