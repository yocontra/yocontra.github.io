/**
 * The web refresh-token cookie. Its attributes come from the environment:
 *
 * - **Production** (`RP_ID` is a real domain, served over https): `__Host-ow_rt`, `Secure; HttpOnly;
 *   SameSite=Strict; Path=/`, host-only on `api.contra.io`. `contra.io` → `api.contra.io` is
 *   same-site, so Strict cookies ride along on `credentials: 'include'` fetches.
 * - **Local dev** (`RP_ID=localhost` or plain http): `ow_rt_<port>`, `HttpOnly; SameSite=Strict;
 *   Path=/` without `Secure` (Safari refuses Secure cookies on http://localhost, and `__Host-`
 *   requires Secure). Cookies ignore ports, so the API port is in the name to keep each stream's
 *   private API from clobbering another's session on the same browser.
 *
 * Owned by stream A.
 */
import { REFRESH_TTL_MS } from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'

export interface CookieConfig {
  name: string
  attributes: string
}

const BASE = 'HttpOnly; SameSite=Strict; Path=/'

export function isDevAuth(env: Env, url: URL): boolean {
  return env.RP_ID === 'localhost' || url.protocol === 'http:'
}

export function cookieConfig(env: Env, url: URL): CookieConfig {
  if (isDevAuth(env, url)) {
    return { name: `ow_rt_${url.port || '80'}`, attributes: BASE }
  }
  return { name: '__Host-ow_rt', attributes: `Secure; ${BASE}` }
}

/** `Set-Cookie` value carrying a new refresh token. */
export function setRefreshCookie(env: Env, url: URL, token: string): string {
  const { name, attributes } = cookieConfig(env, url)
  return `${name}=${token}; ${attributes}; Max-Age=${Math.floor(REFRESH_TTL_MS / 1000)}`
}

/** `Set-Cookie` value that removes the refresh token. */
export function clearRefreshCookie(env: Env, url: URL): string {
  const { name, attributes } = cookieConfig(env, url)
  return `${name}=; ${attributes}; Max-Age=0`
}

/** The refresh token from the request's cookie header, if present. */
export function readRefreshCookie(request: Request, env: Env, url: URL): string | null {
  const header = request.headers.get('Cookie')
  if (!header) {
    return null
  }
  const { name } = cookieConfig(env, url)
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      return value || null
    }
  }
  return null
}
