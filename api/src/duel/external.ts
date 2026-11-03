/**
 * Every other stream's interface that Bounty Hunt uses, in one place.
 *
 * Stream C's economy is real (re-exported below). Stream A's auth has not landed yet, so its
 * functions are TEMPORARY LOCAL STUBS with the exact interfaces.md signatures. When A merges, this
 * block becomes:
 *
 *   export { authenticate, type Player } from '../auth/session.ts'
 *   export { issueTicket, redeemTicket, type TicketPurpose } from '../auth/ticket.ts'
 *   export { isNameOwned } from '../auth/accounts.ts'
 *
 * The stub tokens and tickets share stream C's dev format, `dev:<accountId>:<name>`, and only work
 * on localhost.
 */
import type { Player } from '../economy/auth.ts'
import type { Env } from '../env.ts'

// biome-ignore lint/performance/noBarrelFile: the single seam between Bounty Hunt and other streams
export { authenticate, type Player } from '../economy/auth.ts'
export { gauntletClearStatements } from '../economy/gauntlet.ts'
export {
  isConstraintError,
  isOverdraft,
  type LedgerEntry,
  ledgerStatements,
} from '../economy/ledger.ts'
export { getProfile, getProfileDetail, type Profile } from '../economy/profile.ts'

// --- stream A stubs (TEMPORARY) ------------------------------------------------------------------

export type TicketPurpose = 'duel' | 'town'

const DEV_TICKET = /^dev:(?<id>[\w-]{1,64}):(?<name>[\w .'-]{1,24})$/u
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** STUB (stream A): only for the localhost RP. */
// biome-ignore lint/suspicious/useAwait: matches stream A's async signature
export async function issueTicket(
  env: Env,
  player: Player,
  _purpose: TicketPurpose,
): Promise<string> {
  if (!LOCAL_HOSTS.has(env.RP_ID)) {
    throw new Error('Tickets need stream A.')
  }
  return `dev:${player.accountId}:${player.name}`
}

/** STUB (stream A). The real one is single-use and expires in 30 s. */
// biome-ignore lint/suspicious/useAwait: matches stream A's async signature
export async function redeemTicket(
  env: Env,
  ticket: string,
  _purpose: TicketPurpose,
): Promise<Player | null> {
  if (!LOCAL_HOSTS.has(env.RP_ID)) {
    return null
  }
  const groups = DEV_TICKET.exec(ticket)?.groups
  return groups?.id && groups.name ? { accountId: groups.id, name: groups.name } : null
}

/** STUB (stream A): is this leaderboard name key owned by an account? */
export async function isNameOwned(env: Env, nameKey: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS owned FROM accounts WHERE name_key = ?')
      .bind(nameKey)
      .first<{ owned: number }>()
    return row !== null
  } catch {
    // No accounts.name_key column until stream A lands.
    return false
  }
}
