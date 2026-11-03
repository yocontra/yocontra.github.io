/**
 * Account-facing hooks for other streams.
 * - `accountDeletionStatements`: stream A runs these in the same batch as the account delete.
 *   Ghosts, samples, stats and pair stats cascade; matches are anonymised.
 * - `setGhostOptOutStatements`: "Let my ghost ride" off removes the ghost at once.
 * - `duelStats`: Bounty Hunt standing for the hub and posters.
 */
import type { Env } from '../env.ts'

export function accountDeletionStatements(env: Env, accountId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare('UPDATE matches SET a_id = NULL WHERE a_id = ?').bind(accountId),
    env.DB.prepare('UPDATE matches SET b_id = NULL WHERE b_id = ?').bind(accountId),
    env.DB.prepare('UPDATE matches SET ghost_of = NULL WHERE ghost_of = ?').bind(accountId),
    env.DB.prepare('UPDATE sessions SET account_id = NULL WHERE account_id = ?').bind(accountId),
    // Belt and braces with the cascade: a deleted player must never be served as a ghost.
    env.DB.prepare('DELETE FROM ghost_samples WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM ghost_profiles WHERE account_id = ?').bind(accountId),
  ]
}

/** Opting out deletes the ghost; opting back in starts a fresh one on the next duel. */
export function setGhostOptOutStatements(
  env: Env,
  accountId: string,
  optOut: boolean,
): D1PreparedStatement[] {
  if (!optOut) {
    return [
      env.DB.prepare('UPDATE ghost_profiles SET opt_out = 0 WHERE account_id = ?').bind(accountId),
    ]
  }
  return [
    env.DB.prepare('DELETE FROM ghost_samples WHERE account_id = ?').bind(accountId),
    env.DB.prepare(
      `INSERT INTO ghost_profiles (account_id, name, level, opt_out, updated_at) VALUES (?, '', 1, 1, ?)
       ON CONFLICT (account_id) DO UPDATE SET opt_out = 1, samples = 0, duels = 0, froze = 0,
         fakes_seen = 0, fake_cowards = 0, wait_cowards = 0, wait_seconds = 0`,
    ).bind(accountId, Date.now()),
  ]
}

export interface DuelStats {
  streak: number
  bestStreak: number
  wins: number
  losses: number
  draws: number
  cowardice: number
  /** Hidden from players; exposed for the matchmaker and the server only. */
  drawRating: number
  recent: number[]
  dodges: number[]
  lastWinDay: string | null
  ghostWinsToday: number
}

export const EMPTY_STATS: DuelStats = {
  streak: 0,
  bestStreak: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  cowardice: 0,
  drawRating: 260,
  recent: [],
  dodges: [],
  lastWinDay: null,
  ghostWinsToday: 0,
}

interface StatsRow {
  streak: number
  best_streak: number
  wins: number
  losses: number
  draws: number
  cowardice: number
  draw_rating: number
  recent: string
  dodges: string
  last_win_day: string | null
  ghost_wins_day: string | null
  ghost_wins_today: number
}

const numbers = (text: string): number[] => {
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

export const utcDay = (t = Date.now()): string => new Date(t).toISOString().slice(0, 10)

export async function duelStats(env: Env, accountId: string): Promise<DuelStats> {
  const row = await env.DB.prepare(
    `SELECT streak, best_streak, wins, losses, draws, cowardice, draw_rating, recent, dodges,
            last_win_day, ghost_wins_day, ghost_wins_today FROM duel_stats WHERE account_id = ?`,
  )
    .bind(accountId)
    .first<StatsRow>()
  if (!row) {
    return { ...EMPTY_STATS }
  }
  return {
    streak: row.streak,
    bestStreak: row.best_streak,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    cowardice: row.cowardice,
    drawRating: row.draw_rating,
    recent: numbers(row.recent),
    dodges: numbers(row.dodges),
    lastWinDay: row.last_win_day,
    ghostWinsToday: row.ghost_wins_day === utcDay() ? row.ghost_wins_today : 0,
  }
}

/** Write a whole stats row (computed by the settlement). */
export function duelStatsStatement(env: Env, accountId: string, s: DuelStats): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO duel_stats (account_id, streak, best_streak, wins, losses, draws, cowardice,
       draw_rating, recent, dodges, last_win_day, ghost_wins_day, ghost_wins_today, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT (account_id) DO UPDATE SET streak = ?2, best_streak = ?3, wins = ?4, losses = ?5,
       draws = ?6, cowardice = ?7, draw_rating = ?8, recent = ?9, dodges = ?10, last_win_day = ?11,
       ghost_wins_day = ?12, ghost_wins_today = ?13, updated_at = ?14`,
  ).bind(
    accountId,
    s.streak,
    s.bestStreak,
    s.wins,
    s.losses,
    s.draws,
    s.cowardice,
    s.drawRating,
    JSON.stringify(s.recent.slice(-30)),
    JSON.stringify(s.dodges.slice(-10)),
    s.lastWinDay,
    utcDay(),
    s.ghostWinsToday,
    Date.now(),
  )
}
