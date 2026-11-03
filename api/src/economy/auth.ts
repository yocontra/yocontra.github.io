/**
 * TEMPORARY LOCAL STUB of stream A's `authenticate(request, env)` (`api/src/auth/session.ts`), with
 * the exact signature from interfaces.md. Stream C's routes import auth only through this module,
 * so switching to A's real implementation is a one-line change here once A merges:
 *
 *   export { authenticate, type Player } from '../auth/session.ts'
 *
 * Until then it accepts only `Authorization: Bearer dev:<accountId>:<name>`, and only when the
 * request is addressed to localhost. In production it always returns null (signed out).
 */
import type { Env } from '../env.ts'

export interface Player {
  accountId: string
  name: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEV_TOKEN = /^Bearer dev:(?<id>[\w-]{1,64}):(?<name>[\w .'-]{1,24})$/u

/** Reads `Authorization: Bearer <access token>`. Returns null if missing, invalid or expired. */
// biome-ignore lint/suspicious/useAwait: matches stream A's async signature
export async function authenticate(request: Request, _env: Env): Promise<Player | null> {
  if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) {
    return null
  }
  const groups = DEV_TOKEN.exec(request.headers.get('Authorization') ?? '')?.groups
  return groups?.id && groups.name ? { accountId: groups.id, name: groups.name } : null
}
