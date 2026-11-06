/** Request guards and session responses shared by the auth and account routes. Owned by stream A. */
import {
  type AuthSession,
  CLIENT_HEADER,
  CLIENT_PLATFORMS,
  type ClientPlatform,
  REAUTH_WINDOW_MS,
} from '../../../src/experiments/out-west/contract/auth.ts'
import { isRecord } from '../../../src/experiments/out-west/contract/validate.ts'
import type { Env } from '../env.ts'
import { allowedOrigin, clientHash, error, json } from '../http.ts'
import { setRefreshCookie } from './cookie.ts'
import { hit, type Limit } from './rate.ts'
import type { SessionGrant } from './refresh.ts'
import { authenticateClaims } from './session.ts'
import type { AccessClaims } from './token.ts'
import { signAccessToken } from './token.ts'
import { consumeChallenge, verifyAssertion } from './webauthn.ts'

export const isPlatform = (v: unknown): v is ClientPlatform =>
  typeof v === 'string' && (CLIENT_PLATFORMS as readonly string[]).includes(v)

/** A browser call must come from an allowed origin. Native callers send no Origin at all. */
export function originRejected(request: Request, env: Env, browserOnly = true): Response | null {
  const origin = request.headers.get('Origin')
  if (origin === null && !browserOnly) {
    return null
  }
  return allowedOrigin(request, env) ? null : error(request, env, 403, 'Origin not allowed.')
}

/** Cookie endpoints also need the custom header, which a cross-site form can never send. */
export function webClientRejected(request: Request, env: Env): Response | null {
  return (
    originRejected(request, env) ??
    (request.headers.get(CLIENT_HEADER) === 'web'
      ? null
      : error(request, env, 400, 'Missing client header.'))
  )
}

/** Counts a hit against `limit`; returns a 429 when over. Keyed by client hash unless given. */
export async function limited(
  request: Request,
  env: Env,
  limit: Limit,
  key?: string,
): Promise<Response | null> {
  const verdict = await hit(env, limit, key ?? (await clientHash(request)))
  if (verdict.ok) {
    return null
  }
  return json(
    request,
    env,
    { ok: false, error: 'Too many requests. Wait a moment and try again.' },
    429,
    {
      'Retry-After': String(verdict.retryAfter),
    },
  )
}

/** Signs an access token for a grant and returns it, with the refresh token in a cookie (web) or the body (app). */
export async function sessionResponse(
  request: Request,
  env: Env,
  url: URL,
  { grant, status = 200 }: { grant: SessionGrant; status?: number },
): Promise<Response> {
  const { token, expiresAt } = await signAccessToken(env.AUTH_SECRET, {
    accountId: grant.player.accountId,
    name: grant.player.name,
    sid: grant.familyId,
    platform: grant.platform,
    authTime: grant.authTime,
  })
  const body: AuthSession = { accessToken: token, expiresAt, player: grant.player }
  if (grant.platform !== 'web') {
    body.refreshToken = grant.refreshToken
    return json(request, env, body, status, { 'Cache-Control': 'no-store' })
  }
  return json(request, env, body, status, {
    'Cache-Control': 'no-store',
    'Set-Cookie': setRefreshCookie(env, url, grant.refreshToken),
  })
}

export type Authed = { ok: true; claims: AccessClaims } | { ok: false; response: Response }

export async function requireAuth(request: Request, env: Env): Promise<Authed> {
  const rejected = originRejected(request, env, false)
  if (rejected) {
    return { ok: false, response: rejected }
  }
  const claims = await authenticateClaims(request, env)
  return claims
    ? { ok: true, claims }
    : { ok: false, response: error(request, env, 401, 'Sign in first.') }
}

/** True when the session's passkey ceremony is recent enough for sensitive actions. */
export const isRecent = (claims: AccessClaims, now = Date.now()): boolean =>
  now - claims.auth_time * 1000 <= REAUTH_WINDOW_MS

/**
 * Sensitive actions need a recent ceremony: either the session itself is fresh, or `proof` is a
 * reauth assertion (from `POST /auth/reauth/options`) by one of the account's own passkeys.
 */
export async function reauthOk(env: Env, claims: AccessClaims, proof: unknown): Promise<boolean> {
  if (isRecord(proof)) {
    const row = await consumeChallenge(env, proof.challengeId, 'reauth')
    if (!row || row.account_id !== claims.sub) {
      return false
    }
    return (await verifyAssertion(env, row, proof.response)) === claims.sub
  }
  return isRecent(claims)
}
