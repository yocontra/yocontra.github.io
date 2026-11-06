/**
 * Accounts: passkey registration and login, token refresh, logout, reauth, WebSocket tickets and the
 * app handoff. Owned by stream A. Request and response shapes: `contract/auth.ts`.
 */
import {
  TICKET_PURPOSES,
  TICKET_TTL_MS,
  type TicketPurpose,
} from '../../../src/experiments/out-west/contract/auth.ts'
import { isRecord } from '../../../src/experiments/out-west/contract/validate.ts'
import { createAccount, reserveName } from '../auth/accounts.ts'
import { clearRefreshCookie, readRefreshCookie } from '../auth/cookie.ts'
import { randomToken, sha256Hex } from '../auth/crypto.ts'
import { dailyCheckFor, stampTurnstileDay, TURNSTILE_REQUIRED } from '../auth/daily-turnstile.ts'
import { authorizeAppCode, exchangeAppCode } from '../auth/handoff.ts'
import { LIMITS } from '../auth/rate.ts'
import { endFamily, endSession, rotateSession, startSession } from '../auth/refresh.ts'
import {
  isPlatform,
  limited,
  originRejected,
  requireAuth,
  sessionResponse,
  webClientRejected,
} from '../auth/respond.ts'
import { authenticateClaims } from '../auth/session.ts'
import { AccountGoneError, issueTicket } from '../auth/ticket.ts'
import {
  authenticationOptions,
  consumeChallenge,
  registrationOptions,
  verifyAssertion,
  verifyRegistration,
} from '../auth/webauthn.ts'
import type { Env } from '../env.ts'
import {
  BODY_LARGE,
  clientHash,
  error,
  json,
  type RouteHandler,
  readJson,
  verifyTurnstile,
} from '../http.ts'
import { validateName } from '../names.ts'

type Handler = (request: Request, env: Env, url: URL) => Promise<Response>

async function body(request: Request): Promise<Record<string, unknown>> {
  const v = await readJson(request, BODY_LARGE)
  return isRecord(v) ? v : {}
}

const registerOptions: Handler = async (request, env) => {
  const blocked = originRejected(request, env) ?? (await limited(request, env, LIMITS.register))
  if (blocked) {
    return blocked
  }
  const b = await body(request)
  const name = validateName(b.name)
  if (!name.ok) {
    return error(request, env, 400, name.error)
  }
  const token = b.turnstileToken
  if (typeof token !== 'string' || !(await verifyTurnstile(token, request, env))) {
    return error(request, env, 403, 'Couldn’t check you’re human. Try again.')
  }
  const challengeId = randomToken()
  if (
    !(await reserveName(env, {
      nameKey: name.key,
      challengeId,
      clientHash: await clientHash(request),
    }))
  ) {
    return error(request, env, 409, 'That name is taken. Pick another.')
  }
  const options = await registrationOptions(env, {
    kind: 'register',
    accountId: randomToken(16),
    name: name.name,
    nameKey: name.key,
    challengeId,
  })
  return json(request, env, options)
}

const registerVerify: Handler = async (request, env, url) => {
  const blocked = originRejected(request, env) ?? (await limited(request, env, LIMITS.verify))
  if (blocked) {
    return blocked
  }
  const b = await body(request)
  const row = await consumeChallenge(env, b.challengeId, 'register')
  if (!(row?.name && row.name_key && row.account_id)) {
    return error(request, env, 400, 'That sign-up expired. Try again.')
  }
  const key = await verifyRegistration(env, row, b.response)
  if (!key) {
    return error(request, env, 400, 'That passkey didn’t work. Try again.')
  }
  const player = { accountId: row.account_id, name: row.name }
  const created = await createAccount(env, {
    accountId: player.accountId,
    name: player.name,
    nameKey: row.name_key,
    challengeId: row.id,
    key,
  })
  if (!created) {
    return error(request, env, 409, 'Someone just took that name. Pick another.')
  }
  const grant = await startSession(env, { player, platform: 'web', authTime: Date.now() })
  return await sessionResponse(request, env, url, { grant, status: 201 })
}

const loginOptions: Handler = async (request, env) => {
  const blocked = originRejected(request, env) ?? (await limited(request, env, LIMITS.login))
  if (blocked) {
    return blocked
  }
  return json(request, env, await authenticationOptions(env, 'login'))
}

const loginVerify: Handler = async (request, env, url) => {
  const blocked = originRejected(request, env) ?? (await limited(request, env, LIMITS.verify))
  if (blocked) {
    return blocked
  }
  const b = await body(request)
  const row = await consumeChallenge(env, b.challengeId, 'login')
  if (!row) {
    return error(request, env, 400, 'That sign-in expired. Try again.')
  }
  const accountId = await verifyAssertion(env, row, b.response)
  const name = accountId
    ? await env.DB.prepare('SELECT name FROM accounts WHERE id = ?')
        .bind(accountId)
        .first<{ name: string }>()
    : null
  if (!(accountId && name)) {
    return error(request, env, 401, 'That passkey isn’t linked to an account.')
  }
  const grant = await startSession(env, {
    player: { accountId, name: name.name },
    platform: 'web',
    authTime: Date.now(),
  })
  return await sessionResponse(request, env, url, { grant })
}

/** The refresh token: from the cookie on the web, from the body for app platforms. */
function presentedToken(
  request: Request,
  env: Env,
  url: URL,
  b: Record<string, unknown>,
): string | null {
  if (!isPlatform(b.platform) || b.platform === 'web') {
    return readRefreshCookie(request, env, url)
  }
  return typeof b.refreshToken === 'string' ? b.refreshToken : null
}

/**
 * Who is refreshing, so a rotation whose response was lost can be replayed to the same client only
 * (`rotateSession`). IP plus User-Agent, hashed; never stored.
 */
async function clientBinding(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  return await sha256Hex(`${ip}|${request.headers.get('User-Agent') ?? ''}`)
}

const REFRESH_FAILURES: Record<string, string> = {
  raced: 'Refreshed in another tab. Try again.',
  reused: 'That session was used elsewhere, so it was closed. Sign in again.',
}

/**
 * The first web refresh of each UTC day must carry a Turnstile token (`daily-turnstile.ts`). A
 * refusal is a 403 with `turnstile: 'required'` and doesn't rotate or clear anything, so the client
 * fetches a token and retries with the same cookie. Null means go ahead.
 */
async function dailyTurnstile(
  request: Request,
  env: Env,
  presented: string,
  token: unknown,
): Promise<Response | null> {
  const check = await dailyCheckFor(env, presented)
  if (!check?.due) {
    return null
  }
  if (typeof token === 'string' && token && (await verifyTurnstile(token, request, env))) {
    // Stamped before rotating: a raced or replayed rotation retries without a second token.
    await stampTurnstileDay(env, check.accountId)
    return null
  }
  return json(
    request,
    env,
    { ok: false, error: 'Couldn’t check you’re human. Try again.', turnstile: TURNSTILE_REQUIRED },
    403,
  )
}

const refresh: Handler = async (request, env, url) => {
  const b = await body(request)
  const platform = isPlatform(b.platform) ? b.platform : 'web'
  const isWeb = platform === 'web'
  const blocked =
    (isWeb ? webClientRejected(request, env) : originRejected(request, env, false)) ??
    (await limited(request, env, LIMITS.refresh))
  if (blocked) {
    return blocked
  }
  const presented = presentedToken(request, env, url, b)
  if (!presented) {
    return error(request, env, 401, 'Not signed in.')
  }
  if (isWeb) {
    const refused = await dailyTurnstile(request, env, presented, b.turnstileToken)
    if (refused) {
      return refused
    }
  }
  const result = await rotateSession(env, presented, platform, {
    client: await clientBinding(request),
  })
  if (result.ok) {
    return await sessionResponse(request, env, url, { grant: result.grant })
  }
  const status = result.reason === 'raced' ? 409 : 401
  const res = error(request, env, status, REFRESH_FAILURES[result.reason] ?? 'Not signed in.')
  if (isWeb && status === 401) {
    res.headers.append('Set-Cookie', clearRefreshCookie(env, url))
  }
  return res
}

const logout: Handler = async (request, env, url) => {
  const b = await body(request)
  const isWeb = !isPlatform(b.platform) || b.platform === 'web'
  const blocked = isWeb ? webClientRejected(request, env) : originRejected(request, env, false)
  if (blocked) {
    return blocked
  }
  const presented = presentedToken(request, env, url, b)
  if (presented) {
    await endSession(env, presented)
  }
  const claims = await authenticateClaims(request, env)
  if (claims) {
    await endFamily(env, claims.sub, claims.sid)
  }
  const res = json(request, env, { ok: true })
  if (isWeb) {
    res.headers.append('Set-Cookie', clearRefreshCookie(env, url))
  }
  return res
}

const reauthOptions: Handler = async (request, env) => {
  const auth = await requireAuth(request, env)
  if (!auth.ok) {
    return auth.response
  }
  const blocked = await limited(request, env, LIMITS.sensitive, auth.claims.sub)
  return blocked ?? json(request, env, await authenticationOptions(env, 'reauth', auth.claims.sub))
}

const tickets: Handler = async (request, env) => {
  const auth = await requireAuth(request, env)
  if (!auth.ok) {
    return auth.response
  }
  const blocked = await limited(request, env, LIMITS.tickets, auth.claims.sub)
  if (blocked) {
    return blocked
  }
  const purpose = (await body(request)).purpose
  if (typeof purpose !== 'string' || !(TICKET_PURPOSES as readonly string[]).includes(purpose)) {
    return error(request, env, 400, 'Unknown ticket purpose.')
  }
  try {
    const player = { accountId: auth.claims.sub, name: auth.claims.name }
    const now = Date.now()
    const ticket = await issueTicket(env, player, purpose as TicketPurpose, now)
    return json(request, env, { ticket, expiresAt: now + TICKET_TTL_MS }, 201, {
      'Cache-Control': 'no-store',
    })
  } catch (err) {
    if (err instanceof AccountGoneError) {
      return error(request, env, 401, 'That account is gone. Sign in again.')
    }
    throw err
  }
}

const appAuthorize: Handler = async (request, env) => {
  const auth = await requireAuth(request, env)
  if (!auth.ok) {
    return auth.response
  }
  const blocked = await limited(request, env, LIMITS.sensitive, auth.claims.sub)
  if (blocked) {
    return blocked
  }
  const b = await body(request)
  const result = await authorizeAppCode(env, {
    accountId: auth.claims.sub,
    challenge: b.challenge,
    state: b.state,
    redirectUri: b.redirect_uri,
    purpose: b.purpose,
    authTime: auth.claims.auth_time * 1000,
  })
  return result.ok
    ? json(request, env, { code: result.code, redirect: result.redirect }, 201, {
        'Cache-Control': 'no-store',
      })
    : error(request, env, 400, result.error)
}

const appToken: Handler = async (request, env, url) => {
  const blocked =
    originRejected(request, env, false) ?? (await limited(request, env, LIMITS.appToken))
  if (blocked) {
    return blocked
  }
  const b = await body(request)
  if (!isPlatform(b.platform) || b.platform === 'web') {
    return error(request, env, 400, 'The handoff is for the app only.')
  }
  const code = await exchangeAppCode(env, b.code, b.verifier)
  if (!code) {
    return error(request, env, 400, 'That code is invalid, used or expired.')
  }
  const player = { accountId: code.accountId, name: code.name }
  const grant = await startSession(env, {
    player,
    platform: b.platform,
    authTime: code.authTime,
  })
  return await sessionResponse(request, env, url, { grant })
}

const POST_ROUTES: Readonly<Record<string, Handler>> = {
  '/auth/register/options': registerOptions,
  '/auth/register/verify': registerVerify,
  '/auth/login/options': loginOptions,
  '/auth/login/verify': loginVerify,
  '/auth/refresh': refresh,
  '/auth/logout': logout,
  '/auth/reauth/options': reauthOptions,
  '/auth/app/authorize': appAuthorize,
  '/auth/app/token': appToken,
  '/tickets': tickets,
}

export const authRoutes: RouteHandler = async (request, env, url) => {
  const handler = request.method === 'POST' ? POST_ROUTES[url.pathname] : undefined
  return handler ? await handler(request, env, url) : null
}
