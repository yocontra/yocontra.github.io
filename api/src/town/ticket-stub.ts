/**
 * TEMPORARY LOCAL STUB of stream A's `api/src/auth/ticket.ts`, with the exact signatures from
 * interfaces.md. Delete this file and import from `../auth/ticket.ts` once A merges.
 *
 * Tickets here are stateless HMAC tokens (30 s), single use per isolate. A's real version is
 * single use globally.
 */
import type { Env } from '../env.ts'

export interface Player {
  accountId: string
  name: string
}
export type TicketPurpose = 'duel' | 'town'

const TTL_MS = 30_000
const used = new Map<string, number>()

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

async function sign(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return b64url(new Uint8Array(mac))
}

export async function issueTicket(
  env: Env,
  player: Player,
  purpose: TicketPurpose,
): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(9)))
  const body = b64url(
    new TextEncoder().encode(
      JSON.stringify([purpose, player.accountId, player.name, Date.now() + TTL_MS, nonce]),
    ),
  )
  return `${body}.${await sign(env, body)}`
}

/** Consumes the ticket. Returns null if unknown, expired, used, or for a different purpose. */
export async function redeemTicket(
  env: Env,
  ticket: string,
  purpose: TicketPurpose,
): Promise<Player | null> {
  const [body, mac] = ticket.split('.')
  if (!(body && mac) || (await sign(env, body)) !== mac || used.has(ticket)) {
    return null
  }
  try {
    const json = atob(body.replaceAll('-', '+').replaceAll('_', '/'))
    const [p, accountId, name, exp] = JSON.parse(json) as [string, string, string, number]
    const now = Date.now()
    if (p !== purpose || now > exp) {
      return null
    }
    for (const [t, e] of used) {
      if (e < now) {
        used.delete(t)
      }
    }
    used.set(ticket, exp)
    return { accountId, name }
  } catch {
    return null
  }
}
