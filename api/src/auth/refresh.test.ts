import { describe, expect, it } from 'bun:test'
import { REFRESH_TTL_MS } from '../../../src/experiments/out-west/contract/auth.ts'
import { reserveName } from './accounts.ts'
import { fakeEnv, seedAccount } from './d1-fake.ts'
import { hit, LIMITS } from './rate.ts'
import { endSession, ROTATION_GRACE_MS, rotateSession, startSession } from './refresh.ts'

const player = { accountId: 'acct-refresh-00000001', name: 'Annie Oakley' }

function setup() {
  const env = fakeEnv()
  seedAccount(env, player.accountId, player.name)
  return env
}

describe('refresh tokens', () => {
  it('rotates, keeping the family and auth time', async () => {
    const env = setup()
    const first = await startSession(env, { player, platform: 'web', authTime: 111 })
    const next = await rotateSession(env, first.refreshToken, 'web')
    expect(next).toMatchObject({
      ok: true,
      grant: { familyId: first.familyId, authTime: 111, player },
    })
    expect(next.ok && next.grant.refreshToken).not.toBe(first.refreshToken)
  })

  it('treats a quick second use as a race, a later one as theft', async () => {
    const env = setup()
    const now = Date.now()
    const first = await startSession(env, { player, platform: 'web', authTime: now }, now)
    const second = await rotateSession(env, first.refreshToken, 'web', now)
    expect(await rotateSession(env, first.refreshToken, 'web', now + 1000)).toEqual({
      ok: false,
      reason: 'raced',
    })
    expect(
      await rotateSession(env, first.refreshToken, 'web', now + ROTATION_GRACE_MS + 1),
    ).toEqual({ ok: false, reason: 'reused' })
    // theft detection revoked the whole family, including the legitimate newest token
    const newest = second.ok ? second.grant.refreshToken : ''
    expect(await rotateSession(env, newest, 'web', now + 20_000)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  it('binds tokens to their platform and expiry', async () => {
    const env = setup()
    const now = Date.now()
    const app = await startSession(env, { player, platform: 'ios-app', authTime: now }, now)
    expect(await rotateSession(env, app.refreshToken, 'web', now)).toEqual({
      ok: false,
      reason: 'platform',
    })
    expect(await rotateSession(env, app.refreshToken, 'ios-app', now + REFRESH_TTL_MS)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('logout revokes the family; junk is unknown', async () => {
    const env = setup()
    const s = await startSession(env, { player, platform: 'web', authTime: 1 })
    await endSession(env, s.refreshToken)
    expect(await rotateSession(env, s.refreshToken, 'web')).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect(await rotateSession(env, 'x'.repeat(43), 'web')).toEqual({
      ok: false,
      reason: 'unknown',
    })
    expect(await rotateSession(env, 'short', 'web')).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('name reservations', () => {
  it('holds a name for one client, lets it retry, and frees it on expiry', async () => {
    const env = fakeEnv()
    const now = Date.now()
    const a = { nameKey: 'wildbill', clientHash: 'client-a' }
    expect(await reserveName(env, { ...a, challengeId: 'c1' }, now)).toBe(true)
    expect(await reserveName(env, { ...a, challengeId: 'c2' }, now)).toBe(true)
    const b = { nameKey: 'wildbill', clientHash: 'client-b', challengeId: 'c3' }
    expect(await reserveName(env, b, now)).toBe(false)
    expect(await reserveName(env, b, now + 5 * 60_000)).toBe(true)
  })

  it('refuses names owned by accounts', async () => {
    const env = fakeEnv()
    seedAccount(env, 'acct-owner-0000000001', 'Wild Bill')
    expect(
      await reserveName(env, { nameKey: 'wildbill', clientHash: 'x', challengeId: 'c1' }),
    ).toBe(false)
  })
})

describe('rate limits', () => {
  it('counts per window and reports Retry-After', async () => {
    const env = fakeEnv()
    const limit = { name: 't', max: 2, windowMs: 60_000 }
    const now = 120_000
    expect((await hit(env, limit, 'k', now)).ok).toBe(true)
    expect((await hit(env, limit, 'k', now)).ok).toBe(true)
    const third = await hit(env, limit, 'k', now + 30_000)
    expect(third).toEqual({ ok: false, retryAfter: 30 })
    expect((await hit(env, limit, 'other', now)).ok).toBe(true)
    expect((await hit(env, limit, 'k', now + 60_000)).ok).toBe(true)
    expect(LIMITS.register.max).toBeGreaterThan(0)
  })
})
