/**
 * The bot heuristics' writer (§8 "Timing statistics"): after an account's judged reactions change
 * (a settled Bounty Hunt or ghost duel, a ranked duel from outlaw 6 up), its most recent reactions
 * are checked against `timingTells`, and an account that trips one goes to the Badlands.
 *
 * The evidence is the union of what the server has judged: the ghost ring (`ghost_samples`, last
 * 40 across PvP, ghost and ranked duels) and, because opting out of ghosts deletes that ring, the
 * Bounty Hunt stats' own last 30 (`duel_stats.recent`). The longer of the two is checked.
 */
import type { Env } from '../env.ts'
import { type TimingTell, timingTells } from '../judge.ts'
import { FLAG_BADLANDS, type FlagSource, flagStatements } from './flags.ts'

const parseRecent = (text: string | null | undefined): number[] => {
  try {
    const value = JSON.parse(text ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : []
  } catch {
    return []
  }
}

/** The account's most recent judged reactions, oldest first. */
export async function recentReactions(env: Env, accountId: string): Promise<number[]> {
  const [samples, stats] = await env.DB.batch([
    env.DB.prepare(
      'SELECT ms FROM ghost_samples WHERE account_id = ? ORDER BY id DESC LIMIT 40',
    ).bind(accountId),
    env.DB.prepare('SELECT recent FROM duel_stats WHERE account_id = ?').bind(accountId),
  ])
  const ring = ((samples?.results ?? []) as { ms: number }[]).map((r) => r.ms).reverse()
  const recent = parseRecent((stats?.results as { recent: string }[] | undefined)?.[0]?.recent)
  return ring.length >= recent.length ? ring : recent
}

/**
 * Checks the account's timing and sends it to the Badlands if it trips a tell. Returns the tells
 * (empty when clean). Never throws: moderation must not break a settlement.
 */
export async function reviewTiming(
  env: Env,
  accountId: string,
  source: Extract<FlagSource, 'timing' | 'ranked'> = 'timing',
): Promise<TimingTell[]> {
  try {
    const tells = timingTells(await recentReactions(env, accountId))
    if (tells.length > 0) {
      await env.DB.batch(
        flagStatements(env, {
          accountId,
          bits: FLAG_BADLANDS,
          source,
          detail: tells.join(','),
        }),
      )
    }
    return tells
  } catch (err) {
    console.error('timing review failed', accountId, err)
    return []
  }
}
