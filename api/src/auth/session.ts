/**
 * Who is calling: reads `Authorization: Bearer <access token>`. This is the entry point other streams
 * use (`authenticate(request, env)`). Owned by stream A.
 */
import type { Player } from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import { type AccessClaims, verifyAccessToken } from './token.ts'

export type { Player } from '../../../src/experiments/out-west/contract/auth.ts'

const BEARER = /^Bearer\s+(?<token>[A-Za-z0-9_.-]+)$/u

/** The verified claims behind a request's bearer token, or null. */
export async function authenticateClaims(request: Request, env: Env): Promise<AccessClaims | null> {
  const header = request.headers.get('Authorization')
  const token = header ? BEARER.exec(header)?.groups?.token : undefined
  if (!token) {
    return null
  }
  return await verifyAccessToken(env.AUTH_SECRET, token)
}

/**
 * Reads `Authorization: Bearer <access token>`. Returns null if missing, invalid or expired.
 * Stateless: a deleted account's token stays valid until it expires (at most 15 minutes), but every
 * write keyed on the account fails its foreign key, and tickets check the account still exists.
 */
export async function authenticate(request: Request, env: Env): Promise<Player | null> {
  const claims = await authenticateClaims(request, env)
  return claims ? { accountId: claims.sub, name: claims.name } : null
}
