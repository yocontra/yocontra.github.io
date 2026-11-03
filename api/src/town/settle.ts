/**
 * D1 statements for Frontier money and stats. Every deposit is one batch: its ledger rows (stream
 * C's `ledgerStatements`, idempotent per key) plus the `ffa_deposits` audit row, so a retry with
 * the same key never double-banks. Stats rows are written as absolute values, so they're idempotent.
 */

import type { Player } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { ledgerStatements } from '../economy/ledger.ts'
import type { Env } from '../env.ts'
import type { Session, SettledDeposit } from './core.ts'

export const depositKey = (lobbyId: string, d: SettledDeposit): string =>
  `ffa:${lobbyId}:${d.sessionId}:${d.seq}`

export function depositStatements(
  env: Env,
  lobbyId: string,
  d: SettledDeposit,
): D1PreparedStatement[] {
  const key = depositKey(lobbyId, d)
  return [
    ...ledgerStatements(env, key, [
      { accountId: d.accountId, kind: 'ffa_deposit', amount: d.amount, xp: d.xp, ref: lobbyId },
      { accountId: d.accountId, kind: 'ffa_commission', amount: d.commission, ref: lobbyId },
    ]),
    env.DB.prepare(
      `INSERT OR IGNORE INTO ffa_deposits
         (idem_key, account_id, session_id, lobby_id, seq, amount, commission, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(key, d.accountId, d.sessionId, lobbyId, d.seq, d.amount, d.commission, Date.now()),
    env.DB.prepare(
      `UPDATE ffa_sessions SET banked =
         (SELECT COALESCE(SUM(amount + commission), 0) FROM ffa_deposits WHERE session_id = ?1)
       WHERE id = ?1`,
    ).bind(d.sessionId),
  ]
}

/** Insert the visit row on first join; on a reconnect, clear the `left_at` the disconnect wrote. */
export function sessionStartStatement(env: Env, lobbyId: string, s: Session): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO ffa_sessions (id, account_id, lobby_id, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET left_at = NULL`,
  ).bind(s.sessionId, s.accountId, lobbyId, s.joinedAt)
}

/**
 * Flush unflushed XP (kills, assists, showdowns, strongboxes) as an XP-only ledger entry, plus the
 * session's stats. `flushIndex` keys the XP entry; the caller advances it only on success.
 */
export function xpFlushStatements(
  env: Env,
  s: Session,
  p: Player,
  flushIndex: number,
  leftAt: number | null,
): { statements: D1PreparedStatement[]; xp: number } {
  const xp = Math.max(0, p.stats.xp - s.xpFlushed)
  const st = p.stats
  const statements = [
    ...(xp > 0
      ? ledgerStatements(env, `ffa-xp:${s.sessionId}:${flushIndex}`, [
          { accountId: s.accountId, kind: 'ffa_kill_mint', amount: 0, xp, ref: s.sessionId },
        ])
      : []),
    env.DB.prepare(
      `UPDATE ffa_sessions SET kills = ?, deaths = ?, dead_eye_kills = ?, showdown_wins = ?,
         xp = ?, shots = ?, hits = ?, flags = flags | ?, left_at = COALESCE(?, left_at)
       WHERE id = ?`,
    ).bind(
      st.kills,
      st.deaths,
      st.deadEyeKills,
      st.showdownWins,
      st.xp + st.bankXp,
      st.shots,
      st.hits,
      s.flags,
      leftAt,
      s.sessionId,
    ),
  ]
  return { statements, xp }
}

export interface LobbyStatsDelta {
  occupiedSeconds: number
  peakHumans: number
  messagesIn: number
  minted: number
  burned: number
  deposited: number
  kills: number
}

export function lobbyStatsStatement(
  env: Env,
  lobbyId: string,
  d: LobbyStatsDelta,
): D1PreparedStatement {
  const day = new Date().toISOString().slice(0, 10)
  return env.DB.prepare(
    `INSERT INTO ffa_lobby_stats
       (lobby_id, day, occupied_seconds, peak_humans, messages_in, minted, burned, deposited, kills)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (lobby_id, day) DO UPDATE SET
       occupied_seconds = occupied_seconds + excluded.occupied_seconds,
       peak_humans = MAX(peak_humans, excluded.peak_humans),
       messages_in = messages_in + excluded.messages_in,
       minted = minted + excluded.minted,
       burned = burned + excluded.burned,
       deposited = deposited + excluded.deposited,
       kills = kills + excluded.kills`,
  ).bind(
    lobbyId,
    day,
    Math.round(d.occupiedSeconds),
    d.peakHumans,
    d.messagesIn,
    d.minted,
    d.burned,
    d.deposited,
    d.kills,
  )
}
