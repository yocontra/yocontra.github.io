/**
 * The ranked resume token: an HMAC over the session id, handed out by `POST /sessions` and checked
 * by the WebSocket route before a socket may resume a run. The window itself is enforced by the
 * DuelSession (`run-state.ts`), from its own stored drop time.
 */
import type { Env } from '../env.ts'

async function mac(env: Env, sessionId: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`ranked-resume:${env.AUTH_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`ranked|${sessionId}`)),
  )
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function resumeToken(env: Env, sessionId: string): Promise<string> {
  return hex(await mac(env, sessionId))
}

/** Constant-time check of a presented token. */
export async function verifyResumeToken(
  env: Env,
  sessionId: string,
  token: string,
): Promise<boolean> {
  const want = await resumeToken(env, sessionId)
  if (token.length !== want.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < want.length; i++) {
    diff |= want.charCodeAt(i) ^ token.charCodeAt(i)
  }
  return diff === 0
}
