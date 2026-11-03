/**
 * `GET /players/:name`: a public poster (§12.1). Shows only what an opponent could already see on a
 * poster, plus public records. Banned accounts 404. Badlands accounts look like anyone else (it's a
 * shadow pool, so it must not be revealed).
 */
import type { PlayerPoster } from '../../../src/experiments/out-west/contract/social.ts'
import { licenceStatus } from '../../../src/experiments/out-west/data/licence.ts'
import { bountyForLevel, titleFor } from '../../../src/experiments/out-west/data/progression.ts'
import { duelStats } from '../duel/stats.ts'
import { getProfileDetail } from '../economy/profile.ts'
import { dyesOf } from '../economy/sinks.ts'
import type { Env } from '../env.ts'
import { FLAG_BANNED } from '../moderation/flags.ts'
import { accountByName } from './lookup.ts'

export async function playerPoster(
  env: Env,
  rawName: string,
  viewerId: string | null,
): Promise<PlayerPoster | null> {
  const account = await accountByName(env, rawName)
  if (!account || (account.flags & FLAG_BANNED) !== 0) {
    return null
  }
  const [profile, stats, dyes] = await Promise.all([
    getProfileDetail(env, account.id),
    duelStats(env, account.id),
    dyesOf(env, account.id),
  ])
  if (!profile) {
    return null
  }
  const [frontier, wanted, blocked] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(kills), 0) AS kills, COALESCE(SUM(deaths), 0) AS deaths,
         COALESCE(SUM(banked), 0) AS banked FROM ffa_sessions WHERE account_id = ?`,
    ).bind(account.id),
    env.DB.prepare(
      'SELECT month, rank FROM most_wanted_winners WHERE account_id = ? ORDER BY month DESC',
    ).bind(account.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(
      viewerId ?? '',
      account.id,
    ),
  ])
  const ffa = (
    frontier?.results as { kills: number; deaths: number; banked: number }[] | undefined
  )?.[0]
  const blockedRow = (blocked?.results as { n: number }[] | undefined)?.[0]
  return {
    name: account.name,
    level: profile.level,
    prestige: profile.prestige,
    title: titleFor(profile.level),
    bounty: bountyForLevel(profile.level, stats.streak, profile.prestige),
    licensed: licenceStatus(profile.gauntletClears).licensed,
    loadout: profile.loadout,
    dyes,
    duel: {
      streak: stats.streak,
      bestStreak: stats.bestStreak,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      cowardice: stats.cowardice,
    },
    frontier: { kills: ffa?.kills ?? 0, deaths: ffa?.deaths ?? 0, banked: ffa?.banked ?? 0 },
    mostWanted: (wanted?.results ?? []) as { month: string; rank: number }[],
    joinedAt: account.createdAt,
    blockedByYou: viewerId && viewerId !== account.id ? (blockedRow?.n ?? 0) > 0 : null,
  }
}
