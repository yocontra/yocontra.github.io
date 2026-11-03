/**
 * Turnstile on the first refresh of each UTC day (§8 "Bots"). `accounts.turnstile_day` holds the
 * last UTC day the account passed a check: sign-up stamps it, and so does a refresh that carries a
 * valid token. The refresh route looks the account up from the presented token **before** rotating,
 * so a refresh that's refused for want of a token leaves the token (and the cookie) untouched.
 *
 * Only `web` sessions are checked. App sessions refresh from native code (`expo-secure-store`,
 * §11.2), which has no page to render a widget in. They're born from a web passkey session through
 * the app handoff, and the app's Frontier and queue joins still run Turnstile inside the WebView.
 * App Attest and Play Integrity take this role in the app later (§8).
 */
import type { Env } from '../env.ts'
import { sha256Hex } from './crypto.ts'

/** 'YYYY-MM-DD' in UTC. */
export const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10)

/** Machine-readable marker on the 403 that asks the client for a token and a retry. */
export const TURNSTILE_REQUIRED = 'required'

/**
 * The account behind a presented refresh token, and whether it still owes today's check. Null for
 * a token we don't know (the rotation answers that with its own 401).
 */
export async function dailyCheckFor(
  env: Env,
  presented: string,
  now = Date.now(),
): Promise<{ accountId: string; due: boolean } | null> {
  const row = await env.DB.prepare(
    `SELECT a.id AS account_id, a.turnstile_day
     FROM refresh_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.token_hash = ?`,
  )
    .bind(await sha256Hex(presented))
    .first<{ account_id: string; turnstile_day: string | null }>()
  return row ? { accountId: row.account_id, due: row.turnstile_day !== utcDay(now) } : null
}

/** Records today's pass. */
export async function stampTurnstileDay(
  env: Env,
  accountId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare('UPDATE accounts SET turnstile_day = ? WHERE id = ?')
    .bind(utcDay(now), accountId)
    .run()
}
