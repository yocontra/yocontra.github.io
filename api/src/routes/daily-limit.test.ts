/** The per-IP guest limit on Daily Outlaw tries (`DAILY_GUEST_LIMIT`, routes/daily.ts). */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { signAccessToken } from '../auth/token.ts'
import { createProfile } from '../economy/profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from '../economy/testing/d1.ts'
import type { Env } from '../env.ts'
import { makeDailyRoutes } from './daily.ts'

let t: TestDb
let env: Env
let sessionSeq = 0
/** Calls to the limiter, per key; it allows the first call per key in this test. */
const seen = new Map<string, number>()
const daily = makeDailyRoutes(() => Promise.resolve(true))

beforeAll(async () => {
  t = await testDb()
  env = {
    ...t.env,
    DAILY_SESSIONS: {
      newUniqueId: () => ({ toString: () => (++sessionSeq).toString(16).padStart(64, '0') }),
    },
    DAILY_GUEST_LIMIT: {
      limit: ({ key }: { key: string }) => {
        const n = (seen.get(key) ?? 0) + 1
        seen.set(key, n)
        return Promise.resolve({ success: n <= 1 })
      },
    },
  } as unknown as Env
})
afterAll(async () => {
  await t.dispose()
})

async function post(opts: { ip: string; as?: string; body: unknown }): Promise<Response> {
  const url = new URL('/daily/sessions', 'http://localhost:8822')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: 'http://localhost:4343',
    'CF-Connecting-IP': opts.ip,
  }
  if (opts.as) {
    const { token } = await signAccessToken(env.AUTH_SECRET, {
      accountId: opts.as,
      name: 'Tester',
      sid: 'test-session',
      platform: 'web',
      authTime: Date.now(),
    })
    headers.Authorization = `Bearer ${token}`
  }
  const request = new Request(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  })
  const r = await daily(request, env, url, {} as ExecutionContext)
  if (!r) {
    throw new Error('no route')
  }
  return r
}

const runs = async (): Promise<number> =>
  (await t.db.prepare('SELECT COUNT(*) AS n FROM daily_runs').first<{ n: number }>())?.n ?? 0

describe('guest Daily tries are rate limited per IP', () => {
  it('a second untokened try in the window is refused before any D1 write', async () => {
    const ip = '192.0.2.44'
    expect((await post({ ip, body: {} })).status).toBe(201)
    const before = await runs()
    const second = await post({ ip, body: {} })
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBe('60')
    expect(((await second.json()) as { reason?: string }).reason).toBe('rate_limited')
    expect(await runs()).toBe(before)
  })

  it('another network has its own allowance', async () => {
    expect((await post({ ip: '192.0.2.45', body: {} })).status).toBe(201)
  })

  it('a signed-in try with a valid token never touches the guest limit', async () => {
    const id = freshId()
    await insertAccount(t.db, id, 'Tester')
    await createProfile(env, id, 'Tester')
    const ip = '192.0.2.44'
    const calls = seen.get(`daily-guest:${ip}`)
    expect((await post({ ip, as: id, body: { turnstileToken: 'x' } })).status).toBe(201)
    expect(seen.get(`daily-guest:${ip}`)).toBe(calls)
  })
})
