/**
 * Account management: account info, passkey list/add/remove, and hard deletion ("Hang Up Your
 * Hat"). Owned by stream A. Shapes: `contract/auth.ts`.
 *
 *   GET    /account                  → AccountInfo
 *   DELETE /account { proof? }       → { ok: true }    needs a recent ceremony or a reauth proof
 *   GET    /auth/passkeys            → PasskeyList
 *   POST   /auth/passkeys/options { proof? } → CeremonyOptions (recent ceremony or proof)
 *   POST   /auth/passkeys { challengeId, response } → PasskeyList
 *   DELETE /auth/passkeys/:id { proof? } → PasskeyList (never the last one)
 */

import { isRecord } from '../../../src/experiments/out-west/contract/validate.ts'
import {
  accountName,
  deleteAccount,
  insertPasskey,
  listPasskeys,
  removePasskey,
} from '../auth/accounts.ts'
import { clearRefreshCookie } from '../auth/cookie.ts'
import { LIMITS } from '../auth/rate.ts'
import { limited, reauthOk, requireAuth } from '../auth/respond.ts'
import type { AccessClaims } from '../auth/token.ts'
import { consumeChallenge, registrationOptions, verifyRegistration } from '../auth/webauthn.ts'
import type { Env } from '../env.ts'
import { BODY_LARGE, error, json, type RouteHandler, readJson } from '../http.ts'

type Handler = (request: Request, env: Env, url: URL, claims: AccessClaims) => Promise<Response>

const PASSKEY_PATH = /^\/auth\/passkeys\/(?<id>[A-Za-z0-9_-]{1,1400})$/u
const NO_STORE = { 'Cache-Control': 'no-store' }

async function body(request: Request): Promise<Record<string, unknown>> {
  const v = await readJson(request, BODY_LARGE)
  return isRecord(v) ? v : {}
}

const REAUTH_NEEDED = 'Confirm with your passkey first.'

const getAccount: Handler = async (request, env, _url, claims) => {
  const row = await env.DB.prepare('SELECT name, created_at FROM accounts WHERE id = ?')
    .bind(claims.sub)
    .first<{ name: string; created_at: number }>()
  if (!row) {
    return error(request, env, 401, 'That account no longer exists. Sign in again.')
  }
  return json(
    request,
    env,
    {
      player: { accountId: claims.sub, name: row.name },
      createdAt: row.created_at,
      passkeys: await listPasskeys(env, claims.sub),
    },
    200,
    NO_STORE,
  )
}

const removeAccount: Handler = async (request, env, url, claims) => {
  const blocked = await limited(request, env, LIMITS.sensitive, claims.sub)
  if (blocked) {
    return blocked
  }
  if (!(await reauthOk(env, claims, (await body(request)).proof))) {
    return error(request, env, 403, REAUTH_NEEDED)
  }
  await deleteAccount(env, claims.sub)
  const res = json(request, env, { ok: true }, 200, NO_STORE)
  res.headers.append('Set-Cookie', clearRefreshCookie(env, url))
  return res
}

const getPasskeys: Handler = async (request, env, _url, claims) =>
  json(request, env, { passkeys: await listPasskeys(env, claims.sub) }, 200, NO_STORE)

const passkeyOptions: Handler = async (request, env, _url, claims) => {
  const blocked = await limited(request, env, LIMITS.sensitive, claims.sub)
  if (blocked) {
    return blocked
  }
  if (!(await reauthOk(env, claims, (await body(request)).proof))) {
    return error(request, env, 403, REAUTH_NEEDED)
  }
  const name = await accountName(env, claims.sub)
  if (!name) {
    return error(request, env, 401, 'That account no longer exists. Sign in again.')
  }
  const options = await registrationOptions(env, {
    kind: 'add_passkey',
    accountId: claims.sub,
    name,
  })
  return json(request, env, options, 200, NO_STORE)
}

const addPasskey: Handler = async (request, env, _url, claims) => {
  const b = await body(request)
  const row = await consumeChallenge(env, b.challengeId, 'add_passkey')
  if (!row || row.account_id !== claims.sub) {
    return error(request, env, 400, 'That request expired. Try again.')
  }
  const key = await verifyRegistration(env, row, b.response)
  if (!key) {
    return error(request, env, 400, 'That passkey didn’t work. Try again.')
  }
  try {
    await insertPasskey(env, claims.sub, key, Date.now()).run()
  } catch {
    return error(request, env, 409, 'That passkey is already on an account.')
  }
  return json(request, env, { passkeys: await listPasskeys(env, claims.sub) }, 201, NO_STORE)
}

async function deletePasskey(
  request: Request,
  env: Env,
  claims: AccessClaims,
  id: string,
): Promise<Response> {
  if (!(await reauthOk(env, claims, (await body(request)).proof))) {
    return error(request, env, 403, REAUTH_NEEDED)
  }
  if (!(await removePasskey(env, claims.sub, id))) {
    return error(request, env, 409, 'You need at least one passkey to sign in.')
  }
  return json(request, env, { passkeys: await listPasskeys(env, claims.sub) }, 200, NO_STORE)
}

const ROUTES: Readonly<Record<string, Handler>> = {
  'GET /account': getAccount,
  'DELETE /account': removeAccount,
  'GET /auth/passkeys': getPasskeys,
  'POST /auth/passkeys/options': passkeyOptions,
  'POST /auth/passkeys': addPasskey,
}

export const accountRoutes: RouteHandler = async (request, env, url) => {
  const handler = ROUTES[`${request.method} ${url.pathname}`]
  const passkeyId =
    request.method === 'DELETE' ? PASSKEY_PATH.exec(url.pathname)?.groups?.id : undefined
  if (!(handler || passkeyId)) {
    return null
  }
  const auth = await requireAuth(request, env)
  if (!auth.ok) {
    return auth.response
  }
  if (passkeyId) {
    return await deletePasskey(request, env, auth.claims, passkeyId)
  }
  return handler ? await handler(request, env, url, auth.claims) : null
}
