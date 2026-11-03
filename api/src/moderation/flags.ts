/**
 * `accounts.flags` and the Badlands (§8). The bits: 1 badlands, 2 banned, 4 reported.
 *
 * - **Badlands** is a shadow pool, not a ban. A flagged player keeps playing, but is matched only
 *   with other flagged players or ghosts (Bounty Hunt), rides only in a Badlands lobby (Frontier),
 *   has their payouts frozen (cash credits are booked as $0; XP still counts), is left off the
 *   Most Wanted board, and their ghost is pulled.
 * - **Reported** marks an account several players reported. It changes nothing by itself.
 * - **Banned** is set only by hand (`source: 'admin'`); banned players are refused everywhere
 *   tickets are issued and hidden from public posters.
 *
 * Writers: `reports.ts` (thresholds), `timing.ts` (bot heuristics from judged reactions: Bounty
 * Hunt, ghost duels and ranked runs) and the Frontier lobby (aimbot heuristic). Every change is
 * logged in `moderation_log` with its evidence. Setting a bit that is already set logs nothing.
 */
import type { Env } from '../env.ts'

export const FLAG_BADLANDS = 1
export const FLAG_BANNED = 2
export const FLAG_REPORTED = 4
/** The bits that take an account out of the honest pool. */
export const FLAG_SHADOWED = FLAG_BADLANDS | FLAG_BANNED

export type FlagSource = 'reports' | 'timing' | 'aimbot' | 'ranked' | 'admin'

export const isShadowed = (flags: number): boolean => (flags & FLAG_SHADOWED) !== 0

/**
 * Sets `bits` on the account, logs it (only when something changed), and when it lands in the
 * Badlands pulls its ghost. Statements for the caller's batch; order matters (the log reads the
 * account's flags before the update).
 */
export function flagStatements(
  env: Env,
  opts: { accountId: string; bits: number; source: FlagSource; detail?: string; now?: number },
): D1PreparedStatement[] {
  const now = opts.now ?? Date.now()
  const statements = [
    env.DB.prepare(
      `INSERT INTO moderation_log (account_id, flags, source, detail, created_at)
       SELECT id, ?2, ?3, ?4, ?5 FROM accounts WHERE id = ?1 AND (flags & ?2) != ?2`,
    ).bind(opts.accountId, opts.bits, opts.source, opts.detail ?? null, now),
    env.DB.prepare('UPDATE accounts SET flags = flags | ?2 WHERE id = ?1').bind(
      opts.accountId,
      opts.bits,
    ),
  ]
  if ((opts.bits & FLAG_SHADOWED) !== 0) {
    statements.push(
      env.DB.prepare('UPDATE ghost_profiles SET flagged = 1 WHERE account_id = ?').bind(
        opts.accountId,
      ),
    )
  }
  return statements
}

/** Applies `flagStatements` on its own. */
export async function flagAccount(
  env: Env,
  opts: { accountId: string; bits: number; source: FlagSource; detail?: string },
): Promise<void> {
  await env.DB.batch(flagStatements(env, opts))
}

/** The account's flags (0 for an unknown account). */
export async function accountFlags(env: Env, accountId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT flags FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ flags: number }>()
  return row?.flags ?? 0
}

/** Everything matchmaking needs about an account: its flags and both directions of blocks. */
export interface Standing {
  flags: number
  /** Accounts this one blocks, plus accounts that block this one. */
  blocked: string[]
}

export async function standing(env: Env, accountId: string): Promise<Standing> {
  const [flags, blocks] = await env.DB.batch([
    env.DB.prepare('SELECT flags FROM accounts WHERE id = ?').bind(accountId),
    env.DB.prepare(
      `SELECT blocked_id AS other FROM blocks WHERE blocker_id = ?1
       UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?1`,
    ).bind(accountId),
  ])
  const row = (flags?.results as { flags: number }[] | undefined)?.[0]
  const others = (blocks?.results as { other: string }[] | undefined) ?? []
  return { flags: row?.flags ?? 0, blocked: others.map((r) => r.other) }
}
