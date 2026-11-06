/**
 * Access tokens: compact HS256 JWTs signed with `AUTH_SECRET`, 15 minutes, held in memory by the
 * client. Verification is pure crypto (no D1 read), so every authenticated route stays cheap.
 * Owned by stream A.
 */
import {
  ACCESS_TTL_MS,
  CLIENT_PLATFORMS,
  type ClientPlatform,
} from '../../../src/experiments/out-west/contract/auth.ts'
import { isRecord } from '../../../src/experiments/out-west/contract/validate.ts'
import { b64urlToBytes, bytesToB64url, fromUtf8, hmacSign, hmacVerify, utf8 } from './crypto.ts'

export interface AccessClaims {
  /** Account id. */
  sub: string
  /** Gunslinger name at issue time. */
  name: string
  /** Session (refresh family) id. */
  sid: string
  plat: ClientPlatform
  /** Epoch seconds when the passkey ceremony behind this session happened. */
  auth_time: number
  iat: number
  exp: number
}

const HEADER = bytesToB64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
/** Allowed clock skew when checking `iat`. */
const SKEW_S = 60
const MIN_SECRET_LENGTH = 16

const isPlatform = (v: unknown): v is ClientPlatform =>
  typeof v === 'string' && (CLIENT_PLATFORMS as readonly string[]).includes(v)

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('AUTH_SECRET is missing or too short')
  }
}

export interface AccessInput {
  accountId: string
  name: string
  sid: string
  platform: ClientPlatform
  /** Epoch ms of the passkey ceremony. */
  authTime: number
}

/** Signs a new access token; returns it with its expiry (epoch ms). */
export async function signAccessToken(
  secret: string,
  input: AccessInput,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  assertSecret(secret)
  const iat = Math.floor(now / 1000)
  const exp = iat + Math.floor(ACCESS_TTL_MS / 1000)
  const claims: AccessClaims = {
    sub: input.accountId,
    name: input.name,
    sid: input.sid,
    plat: input.platform,
    auth_time: Math.floor(input.authTime / 1000),
    iat,
    exp,
  }
  const body = `${HEADER}.${bytesToB64url(utf8(JSON.stringify(claims)))}`
  const sig = bytesToB64url(await hmacSign(secret, body))
  return { token: `${body}.${sig}`, expiresAt: exp * 1000 }
}

function parseClaims(payload: string): AccessClaims | null {
  const bytes = b64urlToBytes(payload)
  if (!bytes) {
    return null
  }
  let v: unknown
  try {
    v = JSON.parse(fromUtf8(bytes))
  } catch {
    return null
  }
  if (
    !isRecord(v) ||
    typeof v.sub !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.sid !== 'string' ||
    !isPlatform(v.plat) ||
    typeof v.auth_time !== 'number' ||
    typeof v.iat !== 'number' ||
    typeof v.exp !== 'number'
  ) {
    return null
  }
  return v as unknown as AccessClaims
}

/** Returns the claims of a valid, unexpired token, or null. Never throws on bad input. */
export async function verifyAccessToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<AccessClaims | null> {
  assertSecret(secret)
  const parts = token.split('.')
  const [header, payload, sig] = parts
  if (parts.length !== 3 || header !== HEADER || !payload || !sig) {
    return null
  }
  const sigBytes = b64urlToBytes(sig)
  if (!(sigBytes && (await hmacVerify(secret, `${header}.${payload}`, sigBytes)))) {
    return null
  }
  const claims = parseClaims(payload)
  const nowS = now / 1000
  if (!claims || claims.exp <= nowS || claims.iat > nowS + SKEW_S) {
    return null
  }
  return claims
}
