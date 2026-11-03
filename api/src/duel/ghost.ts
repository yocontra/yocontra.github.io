/**
 * Ghost recording and loading (§6). Every judged human shot (PvP, ghost duels, signed-in ranked
 * duels against outlaw 6 and up) feeds the player's ghost: a ring buffer of the last 40 reactions
 * plus decayed nerve counters and a poster snapshot. A ghost carries only what an opponent already
 * sees: no IP or device data.
 */
import type { Env } from '../env.ts'
import type { GhostTraits } from './opponents.ts'

export const GHOST_RING = 40
export const GHOST_MIN_SAMPLES = 15
export const GHOST_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000
/** Counters halve when `duels` reaches this. */
export const GHOST_DECAY_AT = 100
/** Ranked duels against outlaw index 5 (the 6th) and up seed ghosts. */
export const RANKED_GHOST_MIN_LEVEL = 5

export type SampleSource = 'pvp' | 'ghost' | 'ranked'

export interface GhostSnapshot {
  name: string
  level: number
  prestige: number
  loadout: unknown
  drawRating: number
}

/** One duel's worth of evidence about a player's draw and nerves. */
export interface GhostObservation {
  accountId: string
  source: SampleSource
  /** The judged reaction, if the player fired after the call. */
  reactionMs: number | null
  /** Neither fired in time. */
  froze: boolean
  fakesSeen: number
  /** Drew early within a beat of a fake-out. */
  fakeCoward: boolean
  /** Drew early on nothing. */
  waitCoward: boolean
  waitedMs: number
  snapshot: GhostSnapshot
}

/** Statements that record one observation. Include them in the settlement batch. */
export function ghostRecordStatements(env: Env, o: GhostObservation): D1PreparedStatement[] {
  const now = Date.now()
  const decay = `CASE WHEN duels + 1 >= ${GHOST_DECAY_AT} THEN 0.5 ELSE 1 END`
  const statements = [
    env.DB.prepare(
      `INSERT INTO ghost_profiles (account_id, name, level, prestige, draw_rating, loadout, duels,
         froze, fakes_seen, fake_cowards, wait_cowards, wait_seconds, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (account_id) DO UPDATE SET
         name = excluded.name, level = excluded.level, prestige = excluded.prestige,
         draw_rating = excluded.draw_rating, loadout = excluded.loadout,
         froze = (froze + excluded.froze) * ${decay},
         fakes_seen = (fakes_seen + excluded.fakes_seen) * ${decay},
         fake_cowards = (fake_cowards + excluded.fake_cowards) * ${decay},
         wait_cowards = (wait_cowards + excluded.wait_cowards) * ${decay},
         wait_seconds = (wait_seconds + excluded.wait_seconds) * ${decay},
         duels = (duels + 1) * ${decay},
         updated_at = excluded.updated_at`,
    ).bind(
      o.accountId,
      o.snapshot.name,
      o.snapshot.level,
      o.snapshot.prestige,
      Math.round(o.snapshot.drawRating),
      JSON.stringify(o.snapshot.loadout ?? {}),
      o.froze ? 1 : 0,
      o.fakesSeen,
      o.fakeCoward ? 1 : 0,
      o.waitCoward ? 1 : 0,
      o.waitedMs / 1000,
      now,
    ),
  ]
  if (o.reactionMs !== null) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO ghost_samples (account_id, ms, source, created_at) VALUES (?, ?, ?, ?)',
      ).bind(o.accountId, Math.round(o.reactionMs), o.source, now),
      env.DB.prepare(
        `DELETE FROM ghost_samples WHERE account_id = ?1 AND id NOT IN (
           SELECT id FROM ghost_samples WHERE account_id = ?1 ORDER BY id DESC LIMIT ${GHOST_RING})`,
      ).bind(o.accountId),
      env.DB.prepare(
        `UPDATE ghost_profiles SET samples = (SELECT COUNT(*) FROM ghost_samples WHERE account_id = ?1)
         WHERE account_id = ?1`,
      ).bind(o.accountId),
    )
  }
  return statements
}

/** A ghost the matchmaker may serve. */
export interface GhostCandidate {
  accountId: string
  name: string
  level: number
  prestige: number
  drawRating: number
  loadout: unknown
}

interface GhostRow {
  account_id: string
  name: string
  level: number
  prestige: number
  draw_rating: number
  loadout: string
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Every eligible ghost: ≥15 reactions, active in 30 days, not flagged, not opted out. */
export async function eligibleGhosts(env: Env, limit = 500): Promise<GhostCandidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT account_id, name, level, prestige, draw_rating, loadout FROM ghost_profiles
     WHERE samples >= ? AND opt_out = 0 AND flagged = 0 AND updated_at > ?
     ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(GHOST_MIN_SAMPLES, Date.now() - GHOST_ACTIVE_MS, limit)
    .all<GhostRow>()
  return results.map((r) => ({
    accountId: r.account_id,
    name: r.name,
    level: r.level,
    prestige: r.prestige,
    drawRating: r.draw_rating,
    loadout: parseJson(r.loadout),
  }))
}

/** A ghost's simulation traits, read when its duel starts. Null if it vanished meanwhile. */
export async function loadGhostTraits(env: Env, accountId: string): Promise<GhostTraits | null> {
  const [profile, samples] = await env.DB.batch([
    env.DB.prepare(
      `SELECT duels, froze, fakes_seen, fake_cowards, wait_cowards, wait_seconds FROM ghost_profiles
       WHERE account_id = ? AND opt_out = 0 AND flagged = 0`,
    ).bind(accountId),
    env.DB.prepare(
      `SELECT ms FROM ghost_samples WHERE account_id = ? ORDER BY id DESC LIMIT ${GHOST_RING}`,
    ).bind(accountId),
  ])
  const row = (
    profile?.results as
      | {
          duels: number
          froze: number
          fakes_seen: number
          fake_cowards: number
          wait_cowards: number
          wait_seconds: number
        }[]
      | undefined
  )?.[0]
  if (!row) {
    return null
  }
  return {
    reactions: ((samples?.results ?? []) as { ms: number }[]).map((s) => s.ms),
    duels: row.duels,
    froze: row.froze,
    fakesSeen: row.fakes_seen,
    fakeCowards: row.fake_cowards,
    waitCowards: row.wait_cowards,
    waitSeconds: row.wait_seconds,
  }
}

/** Median of the most recent `n` reactions, or the 260 ms prior with none. */
export function drawRating(recent: readonly number[], n = 30): number {
  const window = recent.slice(-n).filter((ms) => Number.isFinite(ms))
  if (window.length === 0) {
    return 260
  }
  const sorted = [...window].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
  return Math.round(median)
}
