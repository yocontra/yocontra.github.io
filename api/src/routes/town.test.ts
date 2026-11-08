/** `POST /town/join`: Turnstile at every lobby join (§8), checked before the directory is asked. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { COLLISION_VERSION } from '../../../src/experiments/out-west/content/manifest.ts'
import { TOWN_WIRE_VERSION as W } from '../../../src/experiments/out-west/contract/town.ts'
import { PROTOCOL_VERSION } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { fakeEnv, seedAccount, TEST_SECRET } from '../auth/d1-fake.ts'
import { signAccessToken } from '../auth/token.ts'
import { createProfileStatements } from '../economy/profile.ts'
import type { Env } from '../env.ts'
import { LOBBY_WIRE_HEADER } from '../town/wire.ts'
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

async function setup(assigned = false): Promise<{
  env: Env
  bearer: string
  asked: () => number
  forwarded: () => number
  upgradeHeaders: () => Headers | undefined
}> {
  let asks = 0
  let forwards = 0
  let headers: Headers | undefined
  const env = Object.assign(fakeEnv(), {
    LOBBY_DIR: {
      idFromName: () => ({}),
      get: () => ({
        assign: () => {
          asks++
          return Promise.resolve(
            assigned
              ? { ok: true, lobbyId: 'lobby:1', players: 3 }
              : { ok: false, reason: 'all_full' },
          )
        },
      }),
    },
    LOBBIES: {
      idFromName: () => ({}),
      get: () => ({
        reserveNative: () =>
          Promise.resolve({
            name: 'frontier',
            sessionId: 'reserved-session',
            roomId: 'a'.repeat(64),
            processId: 'native',
          }),
        fetch: (request: Request) => {
          forwards++
          headers = request.headers
          return Promise.resolve(new Response('Lobby reached'))
        },
      }),
    },
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
  return {
    env,
    bearer: token,
    asked: () => asks,
    forwarded: () => forwards,
    upgradeHeaders: () => headers,
  }
}

async function join(env: Env, bearer: string, body: unknown): Promise<Response> {
  const request = new Request('http://localhost:8791/town/join', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      typeof body === 'object' && body !== null
        ? { protocol: PROTOCOL_VERSION, collision: COLLISION_VERSION, ...body }
        : body,
    ),
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

  it('refuses missing, older or future wire formats before Turnstile or the directory', async () => {
    const { env, bearer, asked } = await setup()
    for (const body of [
      { turnstileToken: 'ok' },
      { wire: W - 1, turnstileToken: 'ok' },
      { wire: W + 1, turnstileToken: 'ok' },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the counter honest
      const res = await join(env, bearer, body)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, reason: 'outdated' })
    }
    expect(asked()).toBe(0)
  })
})

async function socketUrl(env: Env, bearer: string): Promise<URL> {
  const response = await join(env, bearer, { wire: W, turnstileToken: 'ok' })
  if (response.status !== 201) {
    throw new Error(`Current-version join failed: ${response.status}`)
  }
  const body = (await response.json()) as { wsUrl: string }
  return new URL(body.wsUrl)
}

async function connect(env: Env, url: URL, callerWire?: string): Promise<Response> {
  const headers = new Headers({ Origin: ORIGIN, Upgrade: 'websocket' })
  if (callerWire !== undefined) {
    headers.set(LOBBY_WIRE_HEADER, callerWire)
  }
  const request = new Request(url.toString(), { headers })
  const response = await townRoutes(request, env, url, {} as ExecutionContext)
  if (!response) {
    throw new Error('no socket route')
  }
  return response
}

/** Independent signer reproduces old and wrong-version deployments without changing the ticket. */
async function signSocket(url: URL, domain: string): Promise<void> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${domain}:${TEST_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`lobby:1|acct-1|${url.searchParams.get('exp')}`),
  )
  url.searchParams.set(
    'sig',
    [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  )
}

describe('Frontier socket ticket wire binding', () => {
  it('forwards a current join URL once, with the authenticated lobby and player', async () => {
    const { env, bearer, forwarded, upgradeHeaders } = await setup(true)
    const url = await socketUrl(env, bearer)
    expect((await connect(env, url, String(W - 1))).status).toBe(200)
    expect(forwarded()).toBe(1)
    expect(upgradeHeaders()?.get('X-Lobby-Id')).toBe('lobby:1')
    expect(upgradeHeaders()?.get('X-Account-Id')).toBe('acct-1')
    expect(upgradeHeaders()?.get('X-Name')).toBe('Rider')
    expect(upgradeHeaders()?.get(LOBBY_WIRE_HEADER)).toBe(String(W))
    expect((await connect(env, url)).status).toBe(401)
    expect(forwarded()).toBe(1)
  })

  it.each(['town', `town:v${W - 1}`, `town:v${W + 1}`])(
    'rejects an otherwise valid ticket signed by the %s deployment before reaching the lobby',
    async (domain) => {
      const { env, bearer, forwarded } = await setup(true)
      const url = await socketUrl(env, bearer)
      await signSocket(url, domain)
      const response = await connect(env, url)
      expect(response.status).toBe(403)
      expect(await response.text()).toBe('Wrong town')
      expect(forwarded()).toBe(0)
    },
  )

  it('rejects an expired current-version signature before reaching the lobby', async () => {
    const { env, bearer, forwarded } = await setup(true)
    const url = await socketUrl(env, bearer)
    url.searchParams.set('exp', String(Date.now() - 1))
    await signSocket(url, `town:v${W}`)
    expect((await connect(env, url)).status).toBe(401)
    expect(forwarded()).toBe(0)
  })

  it('rejects a missing signature before reaching the lobby', async () => {
    const { env, bearer, forwarded } = await setup(true)
    const url = await socketUrl(env, bearer)
    url.searchParams.delete('sig')
    expect((await connect(env, url)).status).toBe(403)
    expect(forwarded()).toBe(0)
  })
})

async function joinNative(env: Env, bearer: string, body: unknown) {
  const request = new Request('http://localhost:8791/town/native/join', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const response = await townRoutes(request, env, new URL(request.url), {} as ExecutionContext)
  if (!response) {
    throw new Error('No native route')
  }
  return response
}
describe('native engine join', () => {
  it('requires matching protocol and collision assets before allocating a room', async () => {
    const { env, bearer, asked } = await setup(true)
    const results = await Promise.all(
      [
        { wire: W, turnstileToken: 'pass' },
        {
          wire: W,
          protocol: PROTOCOL_VERSION + 1,
          collision: COLLISION_VERSION,
          turnstileToken: 'pass',
        },
        { wire: W, protocol: PROTOCOL_VERSION, collision: 'old', turnstileToken: 'pass' },
      ].map((body) => joinNative(env, bearer, body)),
    )
    expect(results.map((response) => response.status)).toEqual([409, 409, 409])
    expect(asked()).toBe(0)
  })
  it('issues a native seat behind the existing auth, Turnstile and signed one-use socket ticket', async () => {
    const { env, bearer, asked, forwarded, upgradeHeaders } = await setup(true)
    const response = await joinNative(env, bearer, {
      wire: W,
      protocol: PROTOCOL_VERSION,
      collision: COLLISION_VERSION,
      turnstileToken: 'pass',
    })
    expect(response.status).toBe(201)
    expect(asked()).toBe(1)
    const body = (await response.json()) as {
      reservation: { sessionId: string }
      wsUrl: string
      banked: number
    }
    expect(body.reservation.sessionId).toBe('reserved-session')
    expect(typeof body.banked).toBe('number')
    const url = new URL(body.wsUrl)
    url.searchParams.set('sessionId', body.reservation.sessionId)
    expect((await connect(env, url)).status).toBe(200)
    expect(upgradeHeaders()?.get('X-Native-Room')).toBe('a'.repeat(64))
    expect(upgradeHeaders()?.get('X-Account-Id')).toBe('acct-1')
    expect((await connect(env, url)).status).toBe(401)
    expect(forwarded()).toBe(1)
  })
})
