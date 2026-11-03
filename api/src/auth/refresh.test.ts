import { describe, expect, it } from 'bun:test'
import { REFRESH_TTL_MS } from '../../../src/experiments/out-west/contract/auth.ts'
import { reserveName } from './accounts.ts'
import { fakeEnv, seedAccount } from './d1-fake.ts'
import { hit, LIMITS } from './rate.ts'
import {
  endSession,
  REPLAY_WINDOW_MS,
  ROTATION_GRACE_MS,
  rotateSession,
  startSession,
} from './refresh.ts'

const player = { accountId: 'acct-refresh-00000001', name: 'Annie Oakley' }
const CLIENT = 'client-binding-a'

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
    const second = await rotateSession(env, first.refreshToken, 'web', { now, client: CLIENT })
    // another client presenting the rotated token: a race inside the grace, theft after it
    expect(
      await rotateSession(env, first.refreshToken, 'web', { now: now + 1000, client: 'other' }),
    ).toEqual({
      ok: false,
      reason: 'raced',
    })
    expect(
      await rotateSession(env, first.refreshToken, 'web', {
        now: now + ROTATION_GRACE_MS + 1,
        client: 'other',
      }),
    ).toEqual({ ok: false, reason: 'reused' })
    // theft detection revoked the whole family, including the legitimate newest token
    const newest = second.ok ? second.grant.refreshToken : ''
    expect(await rotateSession(env, newest, 'web', { now: now + 20_000 })).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  it('replays the same successor when the response was lost (page unload mid-refresh)', async () => {
    const env = setup()
    const now = Date.now()
    const first = await startSession(env, { player, platform: 'web', authTime: now }, now)
    // The server rotates and commits, but the browser unloads before it stores the new cookie.
    const lost = await rotateSession(env, first.refreshToken, 'web', { now, client: CLIENT })
    expect(lost.ok).toBe(true)
    const lostToken = lost.ok ? lost.grant.refreshToken : ''
    // The reloaded page presents the old cookie, inside and well past the 10 s race grace.
    for (const later of [500, ROTATION_GRACE_MS + 1, REPLAY_WINDOW_MS - 1]) {
      // biome-ignore lint/performance/noAwaitInLoops: one reload after another
      const again = await rotateSession(env, first.refreshToken, 'web', {
        now: now + later,
        client: CLIENT,
      })
      expect(again).toMatchObject({ ok: true, grant: { familyId: first.familyId, player } })
      expect(again.ok && again.grant.refreshToken).toBe(lostToken)
    }
    // The successor still rotates normally, and the family is intact.
    const next = await rotateSession(env, lostToken, 'web', { now: now + 60_000, client: CLIENT })
    expect(next.ok).toBe(true)
  })

  it('never replays to another client, after the successor was used, or past the window', async () => {
    const env = setup()
    const now = Date.now()
    const s = await startSession(env, { player, platform: 'web', authTime: now }, now)
    expect((await rotateSession(env, s.refreshToken, 'web', { now, client: CLIENT })).ok).toBe(true)
    // a thief elsewhere holding the old token: theft, as before
    expect(
      await rotateSession(env, s.refreshToken, 'web', {
        now: now + ROTATION_GRACE_MS + 1,
        client: 'elsewhere',
      }),
    ).toEqual({ ok: false, reason: 'reused' })

    const t = await startSession(env, { player, platform: 'web', authTime: now }, now)
    const succ = await rotateSession(env, t.refreshToken, 'web', { now, client: CLIENT })
    const succToken = succ.ok ? succ.grant.refreshToken : ''
    // the client got and used the successor, so the old token is genuinely stale
    expect(
      (await rotateSession(env, succToken, 'web', { now: now + 1000, client: CLIENT })).ok,
    ).toBe(true)
    expect(
      await rotateSession(env, t.refreshToken, 'web', { now: now + 2000, client: CLIENT }),
    ).toEqual({
      ok: false,
      reason: 'raced',
    })
    expect(
      await rotateSession(env, t.refreshToken, 'web', {
        now: now + ROTATION_GRACE_MS + 1,
        client: CLIENT,
      }),
    ).toEqual({ ok: false, reason: 'reused' })

    const u = await startSession(env, { player, platform: 'web', authTime: now }, now)
    expect((await rotateSession(env, u.refreshToken, 'web', { now, client: CLIENT })).ok).toBe(true)
    expect(
      await rotateSession(env, u.refreshToken, 'web', {
        now: now + REPLAY_WINDOW_MS + 1,
        client: CLIENT,
      }),
    ).toEqual({ ok: false, reason: 'reused' })
  })

  it('two concurrent rotations of one token from one client get one successor', async () => {
    const env = setup()
    const now = Date.now()
    const s = await startSession(env, { player, platform: 'web', authTime: now }, now)
    const [a, b] = await Promise.all([
      rotateSession(env, s.refreshToken, 'web', { now, client: CLIENT }),
      rotateSession(env, s.refreshToken, 'web', { now, client: CLIENT }),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(a.ok && b.ok && a.grant.refreshToken === b.grant.refreshToken).toBe(true)
    const live = env.sqlite
      .prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE rotated_at IS NULL')
      .get()
    expect(live).toEqual({ n: 1 })
  })

  it('binds tokens to their platform and expiry', async () => {
    const env = setup()
    const now = Date.now()
    const app = await startSession(env, { player, platform: 'ios-app', authTime: now }, now)
    expect(await rotateSession(env, app.refreshToken, 'web', { now })).toEqual({
      ok: false,
      reason: 'platform',
    })
    expect(
      await rotateSession(env, app.refreshToken, 'ios-app', { now: now + REFRESH_TTL_MS }),
    ).toEqual({
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
