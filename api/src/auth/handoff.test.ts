import { describe, expect, it } from 'bun:test'
import { APP_CODE_TTL_MS } from '../../../src/experiments/out-west/contract/auth.ts'
import { randomToken, s256 } from './crypto.ts'
import { fakeEnv, seedAccount } from './d1-fake.ts'
import { authorizeAppCode, exchangeAppCode } from './handoff.ts'

const ACCOUNT = 'acct-handoff-000000001'
const REDIRECT = 'outwest://auth/callback'

async function setup() {
  const env = fakeEnv()
  seedAccount(env, ACCOUNT, 'Doc Holliday')
  const verifier = randomToken(32)
  const challenge = await s256(verifier)
  return { env, verifier, challenge }
}

const authorize = (
  env: ReturnType<typeof fakeEnv>,
  over: Record<string, unknown>,
  now = Date.now(),
) =>
  authorizeAppCode(
    env,
    {
      accountId: ACCOUNT,
      challenge: over.challenge,
      state: over.state ?? 'st4te',
      redirectUri: over.redirectUri ?? REDIRECT,
      purpose: over.purpose,
      authTime: 1234,
    },
    now,
  )

describe('app handoff', () => {
  it('exchanges a code once with the right verifier', async () => {
    const { env, verifier, challenge } = await setup()
    const auth = await authorize(env, { challenge })
    if (!auth.ok) {
      throw new Error(auth.error)
    }
    const redirect = new URL(auth.redirect)
    expect(redirect.protocol).toBe('outwest:')
    expect(redirect.searchParams.get('code')).toBe(auth.code)
    expect(redirect.searchParams.get('state')).toBe('st4te')
    expect(await exchangeAppCode(env, auth.code, verifier)).toEqual({
      accountId: ACCOUNT,
      name: 'Doc Holliday',
      purpose: 'login',
      authTime: 1234,
    })
    expect(await exchangeAppCode(env, auth.code, verifier)).toBeNull()
  })

  it('burns the code on a wrong verifier', async () => {
    const { env, verifier, challenge } = await setup()
    const auth = await authorize(env, { challenge })
    if (!auth.ok) {
      throw new Error(auth.error)
    }
    expect(await exchangeAppCode(env, auth.code, randomToken(32))).toBeNull()
    expect(await exchangeAppCode(env, auth.code, verifier)).toBeNull()
  })

  it('expires after 60 seconds', async () => {
    const { env, verifier, challenge } = await setup()
    const now = Date.now()
    const auth = await authorize(env, { challenge }, now)
    if (!auth.ok) {
      throw new Error(auth.error)
    }
    expect(await exchangeAppCode(env, auth.code, verifier, now + APP_CODE_TTL_MS)).toBeNull()
  })

  it('matches redirect URIs exactly', async () => {
    const { env, challenge } = await setup()
    const bad = [
      'outwest://auth/callback/',
      'outwest://auth/callback?x=1',
      'https://evil.example/out-west/app/callback',
      'https://contra.io.evil.example/out-west/app/callback',
      42,
    ]
    const results = await Promise.all(
      bad.map((redirectUri) => authorize(env, { challenge, redirectUri })),
    )
    expect(results.map((r) => r.ok)).toEqual(bad.map(() => false))
    const https = await authorize(env, {
      challenge,
      redirectUri: 'https://contra.io/out-west/app/callback',
    })
    expect(https.ok).toBe(true)
  })

  it('validates challenge, state and purpose', async () => {
    const { env, challenge } = await setup()
    expect((await authorize(env, { challenge: 'short' })).ok).toBe(false)
    expect((await authorize(env, { challenge, state: '' })).ok).toBe(false)
    expect((await authorize(env, { challenge, purpose: 'admin' })).ok).toBe(false)
    const reauth = await authorize(env, { challenge, purpose: 'reauth' })
    expect(reauth.ok).toBe(true)
  })

  it('rejects malformed codes and verifiers without touching the table', async () => {
    const { env } = await setup()
    expect(await exchangeAppCode(env, 'nope', randomToken(32))).toBeNull()
    expect(await exchangeAppCode(env, randomToken(16), 'too-short')).toBeNull()
    expect(await exchangeAppCode(env, null, null)).toBeNull()
  })
})
