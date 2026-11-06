/**
 * The app handoff (spec §11.3): a PKCE-style one-time code that moves a passkey sign-in from the
 * system browser's auth session into the Expo app.
 *
 * 1. The signed-in web page calls `authorizeAppCode` with the app's S256 `challenge`, `state` and
 *    `redirect_uri` (exact allowlist). The server stores the code's hash for 60 s.
 * 2. The app calls `exchangeAppCode` with the code and its `verifier`. The code is burned on the
 *    first attempt (`used_at` set atomically), whether or not the verifier matches.
 *
 * Owned by stream A.
 */
import {
  APP_CODE_TTL_MS,
  APP_REDIRECT_URIS,
  type AppAuthPurpose,
} from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import { randomToken, s256, safeEqual, sha256Hex } from './crypto.ts'

/** base64url SHA-256: 32 bytes, 43 characters. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/u
/** RFC 7636: 43–128 characters of the unreserved set. */
const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/u
const CODE_SHAPE = /^[A-Za-z0-9_-]{22}$/u
const STATE_SHAPE = /^[\x21-\x7e]{1,256}$/u
const PURPOSES: readonly AppAuthPurpose[] = ['login', 'register', 'reauth']
const HANDOFF_SWEEP_MS = 10 * 60 * 1000

export interface AuthorizeInput {
  accountId: string
  challenge: unknown
  state: unknown
  redirectUri: unknown
  purpose: unknown
  /** Epoch ms of the passkey ceremony behind the caller's session. */
  authTime: number
}

export type AuthorizeResult =
  | { ok: true; code: string; redirect: string }
  | { ok: false; error: string }

export async function authorizeAppCode(
  env: Env,
  input: AuthorizeInput,
  now = Date.now(),
): Promise<AuthorizeResult> {
  const { challenge, state, redirectUri } = input
  const purpose = input.purpose ?? 'login'
  if (typeof redirectUri !== 'string' || !APP_REDIRECT_URIS.includes(redirectUri)) {
    return { ok: false, error: 'That app link isn’t one we know.' }
  }
  if (typeof challenge !== 'string' || !CHALLENGE_SHAPE.test(challenge)) {
    return { ok: false, error: 'The app sent a bad challenge.' }
  }
  if (typeof state !== 'string' || !STATE_SHAPE.test(state)) {
    return { ok: false, error: 'The app sent a bad state.' }
  }
  if (typeof purpose !== 'string' || !(PURPOSES as readonly string[]).includes(purpose)) {
    return { ok: false, error: 'Unknown sign-in purpose.' }
  }
  const code = randomToken(16)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM app_auth_codes WHERE expires_at < ?').bind(now - HANDOFF_SWEEP_MS),
    env.DB.prepare(
      `INSERT INTO app_auth_codes
         (code_hash, account_id, challenge, redirect_uri, purpose, auth_time, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await sha256Hex(code),
      input.accountId,
      challenge,
      redirectUri,
      purpose,
      input.authTime,
      now + APP_CODE_TTL_MS,
    ),
  ])
  const target = new URL(redirectUri)
  target.searchParams.set('code', code)
  target.searchParams.set('state', state)
  return { ok: true, code, redirect: target.toString() }
}

export interface ExchangedCode {
  accountId: string
  name: string
  purpose: AppAuthPurpose
  authTime: number
}

/** Redeems a code with its PKCE verifier. Returns null for anything but a first, valid use. */
export async function exchangeAppCode(
  env: Env,
  code: unknown,
  verifier: unknown,
  now = Date.now(),
): Promise<ExchangedCode | null> {
  if (typeof code !== 'string' || !CODE_SHAPE.test(code)) {
    return null
  }
  if (typeof verifier !== 'string' || !VERIFIER_SHAPE.test(verifier)) {
    return null
  }
  const row = await env.DB.prepare(
    `UPDATE app_auth_codes SET used_at = ?
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING account_id, challenge, purpose, auth_time`,
  )
    .bind(now, await sha256Hex(code), now)
    .first<{ account_id: string; challenge: string; purpose: AppAuthPurpose; auth_time: number }>()
  if (!(row && safeEqual(await s256(verifier), row.challenge))) {
    return null
  }
  const account = await env.DB.prepare('SELECT name FROM accounts WHERE id = ?')
    .bind(row.account_id)
    .first<{ name: string }>()
  if (!account) {
    return null
  }
  return {
    accountId: row.account_id,
    name: account.name,
    purpose: row.purpose,
    authTime: row.auth_time,
  }
}
