/**
 * Every other stream's interface that Bounty Hunt uses, in one place: stream A's auth and tickets,
 * stream C's ledger, profiles and gauntlet grants. All real implementations.
 */
// biome-ignore lint/performance/noBarrelFile: the single seam between Bounty Hunt and other streams
export { isNameOwned } from '../auth/accounts.ts'
export { authenticate, type Player } from '../auth/session.ts'
export { issueTicket, redeemTicket, type TicketPurpose } from '../auth/ticket.ts'
export { gauntletClearStatements } from '../economy/gauntlet.ts'
export {
  isConstraintError,
  isOverdraft,
  type LedgerEntry,
  ledgerStatements,
} from '../economy/ledger.ts'
export { getProfile, getProfileDetail, type Profile } from '../economy/profile.ts'
