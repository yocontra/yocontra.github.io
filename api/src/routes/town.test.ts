/** `POST /town/join`: Turnstile at every lobby join (§8), checked before the directory is asked. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { TOWN_WIRE_VERSION as W } from '../../../src/experiments/out-west/contract/town.ts'
import { fakeEnv, seedAccount, TEST_SECRET } from '../auth/d1-fake.ts'
import { signAccessToken } from '../auth/token.ts'
import { createProfileStatements } from '../economy/profile.ts'
import type { Env } from '../env.ts'
import { townRoutes } from './town.ts'

const ORIGIN = 'http://localhost:4341'

const realFetch = globalThis.fetch
beforeAll(() => {
  // Turnstile's siteverify: pass unless the token says otherwise.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    const token = (init?.body as FormData | undefined)?.get('response')
    return Promise.resolve(Response.json({ success: token !== 'fail' }))
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

async function setup(): Promise<{ env: Env; bearer: string; asked: () => number }> {
  let asks = 0
  const env = fakeEnv({
    // The directory only answers "full", which is enough to show the join got past Turnstile.
    LOBBY_DIR: {
      idFromName: () => ({}),
      get: () => ({
        assign: () => {
          asks++
          return Promise.resolve({ ok: false, reason: 'all_full' })
        },
      }),
    } as unknown as Env['LOBBY_DIR'],
  })
  seedAccount(env, 'acct-1', 'Rider')
  await env.DB.batch(createProfileStatements(env, 'acct-1'))
  env.sqlite.prepare('UPDATE profiles SET gauntlet_clears = 7').run()
  const { token } = await signAccessToken(TEST_SECRET, {
    accountId: 'acct-1',
    name: 'Rider',
    sid: 'sid-1',
    platform: 'web',
    authTime: Date.now(),
  })
  return { env, bearer: token, asked: () => asks }
}

async function join(env: Env, bearer: string, body: unknown): Promise<Response> {
  const request = new Request('http://localhost:8791/town/join', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const res = await townRoutes(request, env, new URL(request.url), {} as ExecutionContext)
  if (!res) {
    throw new Error('no route')
  }
  return res
}

describe('POST /town/join and Turnstile', () => {
  it('refuses a join without a token, or with a failing one, before assigning a lobby', async () => {
    const { env, bearer, asked } = await setup()
    for (const body of [
      { wire: W },
      { wire: W, turnstileToken: '' },
      { wire: W, turnstileToken: 'fail' },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the counter honest
      const res = await join(env, bearer, body)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ ok: false, reason: 'turnstile' })
    }
    expect(asked()).toBe(0)
  })

  it('passes a join with a valid token on to the directory', async () => {
    const { env, bearer, asked } = await setup()
    const res = await join(env, bearer, { wire: W, turnstileToken: 'ok' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ reason: 'all_full' })
    expect(asked()).toBe(1)
  })

  it('sends a client on an older wire format to refresh, before Turnstile or the directory', async () => {
    const { env, bearer, asked } = await setup()
    for (const body of [{ turnstileToken: 'ok' }, { wire: W - 1, turnstileToken: 'ok' }]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the counter honest
      const res = await join(env, bearer, body)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, reason: 'outdated' })
    }
    expect(asked()).toBe(0)
  })
})
