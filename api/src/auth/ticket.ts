/**
 * Single-use WebSocket tickets, valid for 30 s. Browsers can't set headers on a WebSocket, so a
 * client trades its bearer token for a ticket (`POST /tickets`) and puts it in the query string.
 * Only the SHA-256 of a ticket is stored. Owned by stream A.
 */
import {
  TICKET_TTL_MS,
  type TicketPurpose,
} from '../../../src/experiments/out-west/contract/auth.ts'
import type { Env } from '../env.ts'
import { randomToken, sha256Hex } from './crypto.ts'
import type { Player } from './session.ts'

export type { TicketPurpose } from '../../../src/experiments/out-west/contract/auth.ts'

const TICKET_SHAPE = /^[A-Za-z0-9_-]{20,64}$/u
/** Swept rows: anything that expired more than this long ago. */
const TICKET_SWEEP_MS = 5 * 60 * 1000

export class AccountGoneError extends Error {
  constructor() {
    super('account no longer exists')
    this.name = 'AccountGoneError'
  }
}

/**
 * Issues a 30 s single-use ticket. Throws `AccountGoneError` if the account was deleted (the insert
 * selects from `accounts`, so a stale access token can't mint tickets).
 */
export async function issueTicket(
  env: Env,
  player: Player,
  purpose: TicketPurpose,
  now = Date.now(),
): Promise<string> {
  const ticket = randomToken(24)
  const hash = await sha256Hex(ticket)
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM ws_tickets WHERE expires_at < ?').bind(now - TICKET_SWEEP_MS),
    env.DB.prepare(
      `INSERT INTO ws_tickets (ticket_hash, account_id, name, purpose, expires_at)
       SELECT ?, id, name, ?, ? FROM accounts WHERE id = ?`,
    ).bind(hash, purpose, now + TICKET_TTL_MS, player.accountId),
  ])
  if (inserted?.meta.changes !== 1) {
    throw new AccountGoneError()
  }
  return ticket
}

/** Consumes the ticket. Returns null if unknown, expired, used, or for a different purpose. */
export async function redeemTicket(
  env: Env,
  ticket: string,
  purpose: TicketPurpose,
  now = Date.now(),
): Promise<Player | null> {
  if (typeof ticket !== 'string' || !TICKET_SHAPE.test(ticket)) {
    return null
  }
  const hash = await sha256Hex(ticket)
  // One statement, so two sockets racing on the same ticket can't both win.
  const row = await env.DB.prepare(
    `UPDATE ws_tickets SET used_at = ?
     WHERE ticket_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
     RETURNING account_id, name`,
  )
    .bind(now, hash, purpose, now)
    .first<{ account_id: string; name: string }>()
  return row ? { accountId: row.account_id, name: row.name } : null
}
