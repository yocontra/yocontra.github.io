/**
 * Calls into other streams' account lifecycle code, in one place so auth never reaches into their
 * modules directly. Owned by stream A.
 *
 * - Stream C: `createProfile(env, accountId, name)` (api/src/economy/profile.ts), called once
 *   after sign-up. Its profiles, ledger and inventory cascade from `accounts` on delete.
 * - Stream B: `accountDeletionStatements(env, accountId)` anonymises matches; ghost tables cascade.
 */
import type { Env } from '../env.ts'

// STUB(stream C): replace with `import { createProfile } from '../economy/profile.ts'` once
// api/src/economy/profile.ts lands. Same signature; its Profile result is unused here.
// biome-ignore lint/suspicious/useAwait: local stub with the interface's async signature
async function createProfile(_env: Env, _accountId: string, _name: string): Promise<unknown> {
  return null
}

// STUB(stream B): replace with B's `accountDeletionStatements` import once it lands.
function duelDeletionStatements(_env: Env, _accountId: string): D1PreparedStatement[] {
  return []
}

/** Creates the wallet for a brand-new account. Idempotent on C's side. */
export async function onAccountCreated(env: Env, accountId: string, name: string): Promise<void> {
  await createProfile(env, accountId, name)
}

/** Statements other streams need run in the same batch that deletes the account row. */
export function deletionStatements(env: Env, accountId: string): D1PreparedStatement[] {
  return [...duelDeletionStatements(env, accountId)]
}
