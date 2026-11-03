/**
 * Calls into other streams' account lifecycle code, in one place so auth never reaches into their
 * modules directly. Owned by stream A.
 *
 * - Stream C: `createProfileStatements(env, accountId)` (api/src/economy/profile.ts), batched with
 *   the account insert at sign-up. Its profiles, ledger and inventory cascade on delete.
 * - Stream B: `accountDeletionStatements(env, accountId)` anonymises matches; ghost tables cascade.
 */
import { createProfileStatements } from '../economy/profile.ts'
import type { Env } from '../env.ts'

// STUB(stream B): replace with `import { accountDeletionStatements } from '../duel/stats.ts'`
// once stream B's branch is merged into redesign. Same signature.
function duelDeletionStatements(_env: Env, _accountId: string): D1PreparedStatement[] {
  return []
}

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
