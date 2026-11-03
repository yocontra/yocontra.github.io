/**
 * Full passkey ceremonies through the real route handlers, a software authenticator and the real
 * migrations on SQLite: sign up, refresh, ticket, sign out, sign in, add a passkey, app handoff,
 * delete the account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { accountRoutes } from '../routes/account.ts'
import { authRoutes } from '../routes/auth.ts'
import { randomToken, s256 } from './crypto.ts'
import { fakeEnv } from './d1-fake.ts'
import { SoftAuthenticator } from './soft-authenticator.ts'
import { redeemTicket } from './ticket.ts'

const ORIGIN = 'http://localhost:4341'
const API = 'http://localhost:8791'
const COOKIE = 'ow_rt_8791'

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

type Env = ReturnType<typeof fakeEnv>

interface Call {
  method?: string
  body?: unknown
  bearer?: string
  cookie?: string
  origin?: string | null
  client?: boolean
}

async function call(env: Env, path: string, c: Call = {}): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (c.origin !== null) {
    headers.set('Origin', c.origin ?? ORIGIN)
  }
  if (c.bearer) {
    headers.set('Authorization', `Bearer ${c.bearer}`)
  }
  if (c.cookie) {
    headers.set('Cookie', `${COOKIE}=${c.cookie}`)
  }
  if (c.client !== false) {
    headers.set('X-OW-Client', 'web')
  }
  const request = new Request(`${API}${path}`, {
    method: c.method ?? 'POST',
    headers,
    ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
  })
  const url = new URL(request.url)
  const ctx = {} as ExecutionContext
  const res =
    (await authRoutes(request, env, url, ctx)) ?? (await accountRoutes(request, env, url, ctx))
  if (!res) {
    throw new Error(`no route for ${path}`)
  }
  return res
}

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>

function cookieOf(res: Response): string {
  const set = res.headers.get('Set-Cookie') ?? ''
  const m = new RegExp(`${COOKIE}=([^;]*)`, 'u').exec(set)
  return m?.[1] ?? ''
}

async function signUp(env: Env, name: string, key: SoftAuthenticator) {
  const opts = await json(
    await call(env, '/auth/register/options', { body: { name, turnstileToken: 'ok' } }),
  )
  const response = await key.register(opts.options)
  const res = await call(env, '/auth/register/verify', {
    body: { challengeId: opts.challengeId, response },
  })
  return { res, body: await json(res) }
}

describe('passkey account lifecycle', () => {
  it('signs up, refreshes, tickets, signs out, signs in and deletes', async () => {
    const env = fakeEnv()
    const key = new SoftAuthenticator(ORIGIN)

    const up = await signUp(env, '  Wild   Bill ', key)
    expect(up.res.status).toBe(201)
    expect(up.body.player).toMatchObject({ name: 'Wild Bill' })
    const set = up.res.headers.get('Set-Cookie') ?? ''
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    expect(set).not.toContain('Secure')
    const access = String(up.body.accessToken)
    let cookie = cookieOf(up.res)
    expect(cookie.length).toBeGreaterThan(40)

    // refresh rotates the cookie
    const r1 = await call(env, '/auth/refresh', { body: {}, cookie })
    expect(r1.status).toBe(200)
    const rotated = cookieOf(r1)
    expect(rotated).not.toBe(cookie)
    cookie = rotated

    // cookie endpoints need the client header (CSRF)
    expect((await call(env, '/auth/refresh', { body: {}, cookie, client: false })).status).toBe(400)
    expect(
      (await call(env, '/auth/refresh', { body: {}, cookie, origin: 'https://evil.example' }))
        .status,
    ).toBe(403)

    // a ticket for the duel socket
    const t = await call(env, '/tickets', { body: { purpose: 'duel' }, bearer: access })
    expect(t.status).toBe(201)
    const ticket = String((await json(t)).ticket)
    expect(await redeemTicket(env, ticket, 'duel')).toMatchObject({ name: 'Wild Bill' })
    expect(
      (await call(env, '/tickets', { body: { purpose: 'bank' }, bearer: access })).status,
    ).toBe(400)
    expect((await call(env, '/tickets', { body: { purpose: 'duel' } })).status).toBe(401)

    // sign out kills the session
    const out = await call(env, '/auth/logout', { body: {}, cookie, bearer: access })
    expect(out.status).toBe(200)
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect((await call(env, '/auth/refresh', { body: {}, cookie })).status).toBe(401)

    // sign in with the discoverable passkey
    const lo = await json(await call(env, '/auth/login/options', { body: {} }))
    const assertion = await key.assert(lo.options)
    const inRes = await call(env, '/auth/login/verify', {
      body: { challengeId: lo.challengeId, response: assertion },
    })
    expect(inRes.status).toBe(200)
    const signedIn = await json(inRes)
    expect(signedIn.player).toEqual(up.body.player)

    // a challenge is single-use
    const replay = await call(env, '/auth/login/verify', {
      body: { challengeId: lo.challengeId, response: assertion },
    })
    expect(replay.status).toBe(400)

    // account info
    const info = await json(
      await call(env, '/account', { method: 'GET', bearer: String(signedIn.accessToken) }),
    )
    expect(info.passkeys).toHaveLength(1)

    // delete (the session is fresh, so no extra proof needed)
    const del = await call(env, '/account', {
      method: 'DELETE',
      body: {},
      bearer: String(signedIn.accessToken),
    })
    expect(del.status).toBe(200)
    expect(env.sqlite.prepare('SELECT COUNT(*) AS n FROM passkeys').get()).toEqual({ n: 0 })
    expect(env.sqlite.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get()).toEqual({ n: 0 })
    expect(
      (await call(env, '/tickets', { body: { purpose: 'duel' }, bearer: access })).status,
    ).toBe(401)

    // the name is held for 30 days after deletion
    const again = await call(env, '/auth/register/options', {
      body: { name: 'wild bill', turnstileToken: 'ok' },
    })
    expect(again.status).toBe(409)
  })

  it('validates names and Turnstile at sign-up', async () => {
    const env = fakeEnv()
    const bad = await call(env, '/auth/register/options', {
      body: { name: 'sh1t head', turnstileToken: 'ok' },
    })
    expect(bad.status).toBe(400)
    const long = await call(env, '/auth/register/options', {
      body: { name: 'x'.repeat(17), turnstileToken: 'ok' },
    })
    expect(long.status).toBe(400)
    const bot = await call(env, '/auth/register/options', {
      body: { name: 'Doc', turnstileToken: 'fail' },
    })
    expect(bot.status).toBe(403)
    await signUp(env, 'Doc', new SoftAuthenticator(ORIGIN))
    const taken = await call(env, '/auth/register/options', {
      body: { name: 'DOC', turnstileToken: 'ok' },
    })
    expect(taken.status).toBe(409)
  })

  it('rejects a passkey made for another origin', async () => {
    const env = fakeEnv()
    const { res } = await signUp(env, 'Mallory', new SoftAuthenticator('https://evil.example'))
    expect(res.status).toBe(400)
  })

  it('needs a reauth proof to delete an older session', async () => {
    const env = fakeEnv()
    const key = new SoftAuthenticator(ORIGIN)
    const up = await signUp(env, 'Belle Starr', key)
    // age the session's ceremony beyond the reauth window
    env.sqlite.prepare('UPDATE refresh_tokens SET auth_time = 0').run()
    const r = await json(await call(env, '/auth/refresh', { body: {}, cookie: cookieOf(up.res) }))
    const bearer = String(r.accessToken)
    expect((await call(env, '/account', { method: 'DELETE', body: {}, bearer })).status).toBe(403)
    const ro = await json(await call(env, '/auth/reauth/options', { body: {}, bearer }))
    const proof = { challengeId: ro.challengeId, response: await key.assert(ro.options) }
    expect(
      (await call(env, '/account', { method: 'DELETE', body: { proof }, bearer })).status,
    ).toBe(200)
    expect(env.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  })

  it('adds a second passkey and refuses to remove the last', async () => {
    const env = fakeEnv()
    const first = new SoftAuthenticator(ORIGIN)
    const up = await signUp(env, 'Bass Reeves', first)
    const bearer = String(up.body.accessToken)
    const second = new SoftAuthenticator(ORIGIN)
    const po = await json(await call(env, '/auth/passkeys/options', { body: {}, bearer }))
    const added = await call(env, '/auth/passkeys', {
      body: { challengeId: po.challengeId, response: await second.register(po.options) },
      bearer,
    })
    expect(added.status).toBe(201)
    expect((await json(added)).passkeys).toHaveLength(2)
    const del1 = await call(env, `/auth/passkeys/${first.credentialId}`, {
      method: 'DELETE',
      body: {},
      bearer,
    })
    expect(del1.status).toBe(200)
    const del2 = await call(env, `/auth/passkeys/${second.credentialId}`, {
      method: 'DELETE',
      body: {},
      bearer,
    })
    expect(del2.status).toBe(409)
  })

  it('hands a session to the app with PKCE', async () => {
    const env = fakeEnv()
    const up = await signUp(env, 'Wyatt', new SoftAuthenticator(ORIGIN))
    const verifier = randomToken(32)
    const az = await call(env, '/auth/app/authorize', {
      bearer: String(up.body.accessToken),
      body: {
        challenge: await s256(verifier),
        state: 'xyz',
        redirect_uri: 'outwest://auth/callback',
      },
    })
    expect(az.status).toBe(201)
    const { code } = await json(az)
    // the app has no Origin header
    const tok = await call(env, '/auth/app/token', {
      origin: null,
      client: false,
      body: { code, verifier, platform: 'ios-app' },
    })
    expect(tok.status).toBe(200)
    const session = await json(tok)
    expect(tok.headers.get('Set-Cookie')).toBeNull()
    expect(typeof session.refreshToken).toBe('string')
    // the app refreshes with the body token
    const rr = await call(env, '/auth/refresh', {
      origin: null,
      client: false,
      body: { refreshToken: session.refreshToken, platform: 'ios-app' },
    })
    expect(rr.status).toBe(200)
    // single use
    const again = await call(env, '/auth/app/token', {
      origin: null,
      body: { code, verifier, platform: 'ios-app' },
    })
    expect(again.status).toBe(400)
  })
})

describe('production cookie', () => {
  it('uses __Host- with Secure on https', async () => {
    const env = fakeEnv({
      RP_ID: 'contra.io',
      RP_ORIGINS: 'https://contra.io',
      ALLOWED_ORIGINS: 'https://contra.io',
    })
    const { setRefreshCookie } = await import('./cookie.ts')
    const value = setRefreshCookie(env, new URL('https://api.contra.io/auth/refresh'), 'tok')
    expect(value).toStartWith('__Host-ow_rt=tok; Secure; HttpOnly; SameSite=Strict; Path=/;')
    expect(value).not.toContain('Domain')
  })
})
