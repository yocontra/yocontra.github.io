/**
 * Passkey ceremonies with `@simplewebauthn/server` (WebCrypto, runs on Workers). RP id and the
 * accepted origins come from `RP_ID` / `RP_ORIGINS`. Challenges live in D1 for 5 minutes and are
 * consumed by the first verify attempt. Owned by stream A.
 *
 * Policy (spec §12.3): discoverable credentials (`residentKey: required`), `userVerification:
 * preferred`, `attestation: none`.
 */
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import {
  type CeremonyOptions,
  CHALLENGE_TTL_MS,
} from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import type { NewPasskey } from './accounts.ts'
import { b64urlToBytes, bytesToB64url, randomToken } from './crypto.ts'

export type CeremonyKind = 'register' | 'login' | 'reauth' | 'add_passkey'

const RP_NAME = 'out west'
const TIMEOUT_MS = 120_000
const ID_SHAPE = /^[A-Za-z0-9_-]{16,64}$/u
/** Credential ids are at most 1023 bytes (1364 base64url characters). */
const CREDENTIAL_ID_SHAPE = /^[A-Za-z0-9_-]{1,1400}$/u

export interface ChallengeRow {
  id: string
  challenge: string
  kind: CeremonyKind
  name: string | null
  name_key: string | null
  account_id: string | null
}

export function rpOrigins(env: Env): string[] {
  return env.RP_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Cheap shape check before handing untrusted JSON to the verifier. */
function looksLikeCredential(v: unknown): v is { id: string; type: string; response: object } {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    CREDENTIAL_ID_SHAPE.test(v.id) &&
    v.type === 'public-key' &&
    isRecord(v.response)
  )
}

interface ChallengeInput {
  kind: CeremonyKind
  challenge: string
  id?: string | undefined
  name?: string
  nameKey?: string
  accountId?: string
}

async function storeChallenge(env: Env, input: ChallengeInput, now: number): Promise<string> {
  const { kind, challenge, ...extra } = input
  const id = input.id ?? randomToken()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare(
      `INSERT INTO webauthn_challenges (id, challenge, kind, name, name_key, account_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      challenge,
      kind,
      extra.name ?? null,
      extra.nameKey ?? null,
      extra.accountId ?? null,
      now + CHALLENGE_TTL_MS,
    ),
  ])
  return id
}

/** Deletes and returns a live challenge of this kind; null if unknown, expired or used. */
export async function consumeChallenge(
  env: Env,
  id: unknown,
  kind: CeremonyKind,
  now = Date.now(),
): Promise<ChallengeRow | null> {
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) {
    return null
  }
  return await env.DB.prepare(
    `DELETE FROM webauthn_challenges WHERE id = ? AND kind = ? AND expires_at > ?
     RETURNING id, challenge, kind, name, name_key, account_id`,
  )
    .bind(id, kind, now)
    .first<ChallengeRow>()
}

async function existingCredentials(env: Env, accountId: string): Promise<{ id: string }[]> {
  const { results } = await env.DB.prepare(
    'SELECT credential_id FROM passkeys WHERE account_id = ?',
  )
    .bind(accountId)
    .all<{ credential_id: string }>()
  return results.map((r) => ({ id: r.credential_id }))
}

/**
 * Creation options. For a new account `challengeId` is supplied by the caller, because the
 * name reservation already references it.
 */
export async function registrationOptions(
  env: Env,
  input: {
    kind: 'register' | 'add_passkey'
    accountId: string
    name: string
    nameKey?: string
    challengeId?: string
  },
  now = Date.now(),
): Promise<CeremonyOptions> {
  const userID = b64urlToBytes(input.accountId)
  if (!userID) {
    throw new Error('bad account id')
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: env.RP_ID,
    userName: input.name,
    userDisplayName: input.name,
    userID,
    timeout: TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials:
      input.kind === 'add_passkey' ? await existingCredentials(env, input.accountId) : [],
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  })
  const challengeId = await storeChallenge(
    env,
    {
      kind: input.kind,
      challenge: options.challenge,
      id: input.challengeId,
      name: input.name,
      accountId: input.accountId,
      ...(input.nameKey === undefined ? {} : { nameKey: input.nameKey }),
    },
    now,
  )
  return { challengeId, options }
}

/** Request options: discoverable for login; restricted to the account's own keys for reauth. */
export async function authenticationOptions(
  env: Env,
  kind: 'login' | 'reauth',
  accountId?: string,
  now = Date.now(),
): Promise<CeremonyOptions> {
  const allowCredentials =
    kind === 'reauth' && accountId ? await existingCredentials(env, accountId) : []
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    timeout: TIMEOUT_MS,
    userVerification: 'preferred',
    allowCredentials,
  })
  const challengeId = await storeChallenge(
    env,
    { kind, challenge: options.challenge, ...(accountId ? { accountId } : {}) },
    now,
  )
  return { challengeId, options }
}

/** Verifies an attestation against a consumed challenge. Null on any failure. */
export async function verifyRegistration(
  env: Env,
  row: ChallengeRow,
  response: unknown,
): Promise<NewPasskey | null> {
  if (!looksLikeCredential(response)) {
    return null
  }
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: row.challenge,
      expectedOrigin: rpOrigins(env),
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
    })
    if (!result.verified) {
      return null
    }
    const info = result.registrationInfo
    return {
      credentialId: info.credential.id,
      publicKey: bytesToB64url(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      aaguid: info.aaguid,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    }
  } catch (err) {
    console.warn('registration verify failed', err)
    return null
  }
}

interface StoredKey {
  account_id: string
  public_key: string
  counter: number
  transports: string | null
}

function parseTransports(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/**
 * Verifies an assertion against a consumed challenge and bumps the passkey's counter. For reauth
 * the passkey must belong to the challenge's account. Returns the account id, or null.
 */
export async function verifyAssertion(
  env: Env,
  row: ChallengeRow,
  response: unknown,
  now = Date.now(),
): Promise<string | null> {
  if (!looksLikeCredential(response)) {
    return null
  }
  const key = await env.DB.prepare(
    'SELECT account_id, public_key, counter, transports FROM passkeys WHERE credential_id = ?',
  )
    .bind(response.id)
    .first<StoredKey>()
  const publicKey = key ? b64urlToBytes(key.public_key) : null
  if (!(key && publicKey) || (row.account_id !== null && row.account_id !== key.account_id)) {
    return null
  }
  const handle = (response as AuthenticationResponseJSON).response.userHandle
  if (handle && handle !== key.account_id) {
    return null
  }
  try {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: row.challenge,
      expectedOrigin: rpOrigins(env),
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
      credential: {
        id: response.id,
        publicKey,
        counter: key.counter,
        transports: parseTransports(key.transports),
      },
    })
    if (!result.verified) {
      return null
    }
    await env.DB.prepare(
      `UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ?
       WHERE credential_id = ?`,
    )
      .bind(
        result.authenticationInfo.newCounter,
        now,
        result.authenticationInfo.credentialBackedUp ? 1 : 0,
        response.id,
      )
      .run()
    return key.account_id
  } catch (err) {
    console.warn('assertion verify failed', err)
    return null
  }
}
