/**
 * Calls into other streams' account lifecycle code, in one place so auth never reaches into their
 * modules directly. Owned by stream A.
 *
 * - Stream C: `createProfileStatements(env, accountId)` (api/src/economy/profile.ts), batched with
 *   the account insert at sign-up. Its profiles, ledger and inventory cascade on delete.
 * - Stream B: `accountDeletionStatements(env, accountId)` anonymises matches; ghost tables cascade.
 */
import { accountDeletionStatements as duelDeletionStatements } from '../duel/stats.ts'
import { createProfileStatements } from '../economy/profile.ts'
import type { Env } from '../env.ts'

/**
 * Statements that create the new account's wallet (profile, starter items, $250 start grant). They
 * run in the same batch as the account insert, so the account and its wallet commit together.
 */
export function creationStatements(env: Env, accountId: string): D1PreparedStatement[] {
  return createProfileStatements(env, accountId)
}

/** Statements other streams need run in the same batch that deletes the account row. */
export function deletionStatements(env: Env, accountId: string): D1PreparedStatement[] {
  return [...duelDeletionStatements(env, accountId)]
}
