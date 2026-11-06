/** Shared HTTP plumbing for every route module. Owned by the lead. */
import type { Env } from './env.ts'

/** A route module claims a request by returning a Response, or passes with null. */
export type RouteHandler = (
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
) => Promise<Response | null>

export function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin')
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  return origin && allowed.includes(origin) ? origin : null
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = allowedOrigin(request, env)
  if (!origin) {
    return {}
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-OW-Client',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

// biome-ignore lint/complexity/useMaxParams: every route calls json(request, env, body, status?, headers?); the two optionals keep the common call short
export function json(
  request: Request,
  env: Env,
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
      ...extra,
    },
  })
}

export function error(request: Request, env: Env, status: number, message: string): Response {
  return json(request, env, { ok: false, error: message }, status)
}

/**
 * Request body caps, in bytes. Every route picks the smallest one that fits: a body larger than
 * the endpoint can use is wasted memory and a needless parse.
 */
/** One id or flag. */
export const BODY_TINY = 1024
/** One small object (two or three fields). */
export const BODY_SMALL = 2048
/** A loadout: nine slot ids. */
export const BODY_LOADOUT = 4 * 1024
/** A normal command body (a token, a claim, a request id). */
export const BODY_STANDARD = 8 * 1024
/** A WebAuthn assertion or registration response. */
export const BODY_LARGE = 32 * 1024
/** Default when a route has no tighter estimate. */
export const BODY_DEFAULT = 16 * 1024

/** Parse a JSON body with a size cap. Returns undefined on oversize or invalid JSON. */
export async function readJson(request: Request, maxBytes = BODY_DEFAULT): Promise<unknown> {
  const text = await request.text()
  if (text.length > maxBytes) {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** SHA-256 of client IP + daily salt. Used for rate limiting; raw IPs are never stored. */
export async function clientHash(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const day = new Date().toISOString().slice(0, 10)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${day}`))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyTurnstile(token: string, request: Request, env: Env): Promise<boolean> {
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET)
  form.append('response', token)
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) {
    form.append('remoteip', ip)
  }
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  })
  const outcome = await res.json<{ success: boolean }>()
  return outcome.success
}
