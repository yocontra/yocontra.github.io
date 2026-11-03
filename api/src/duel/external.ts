/**
 * TEMPORARY LOCAL STUBS of other streams' interfaces (interfaces.md), with their exact signatures.
 *
 * Every Bounty Hunt module imports these names from here and nowhere else, so when stream A's
 * `api/src/auth/*`, stream C's `api/src/economy/*` and `data/{progression,catalog}.ts` land, this
 * whole file is replaced by plain re-exports:
 *
 *   export { authenticate, type Player } from '../auth/session.ts'
 *   export { issueTicket, redeemTicket } from '../auth/ticket.ts'
 *   export { isNameOwned } from '../auth/accounts.ts'
 *   export { ledgerStatements, type LedgerEntry } from '../economy/ledger.ts'
 *   export { getProfile, type Profile } from '../economy/profile.ts'
 *   export { gauntletClearStatements } from '../economy/gauntlet.ts'
 *   export { baseBounty, bountyForLevel, duelPayout, duelPenalty, duelXp, pairFactor, … }
 *     from '../../../src/experiments/out-west/data/progression.ts'
 *   export { type Loadout, normalizeLoadout } from '../../../src/experiments/out-west/data/catalog.ts'
 *
 * The stubs are dev-grade: tokens and tickets are `dev.<accountId>.<name>` and are accepted only
 * when `RP_ID` is `localhost`; the ledger writes the spec's `profiles`/`ledger` shape.
 */
import type { Env } from '../env.ts'

// biome-ignore-start lint/suspicious/useAwait: stubs mirror async signatures

// --- stream A ------------------------------------------------------------------------------------

export interface Player {
  accountId: string
  name: string
}
export type TicketPurpose = 'duel' | 'town'

const DEV_TOKEN = /^dev\.(?<id>[A-Za-z0-9_-]{1,64})\.(?<name>[^.]{1,32})$/u

function devPlayer(env: Env, token: string | null | undefined): Player | null {
  if (env.RP_ID !== 'localhost' || !token) {
    return null
  }
  const m = DEV_TOKEN.exec(token)
  const id = m?.groups?.id
  const name = m?.groups?.name
  return id && name ? { accountId: id, name: decodeURIComponent(name) } : null
}

/** STUB (stream A). Reads `Authorization: Bearer <access token>`. */
export async function authenticate(request: Request, env: Env): Promise<Player | null> {
  const header = request.headers.get('Authorization') ?? ''
  return devPlayer(env, header.startsWith('Bearer ') ? header.slice(7) : null)
}

/** STUB (stream A). */
export async function issueTicket(
  _env: Env,
  player: Player,
  _purpose: TicketPurpose,
): Promise<string> {
  return `dev.${player.accountId}.${encodeURIComponent(player.name)}`
}

/** STUB (stream A). Single use in the real implementation. */
export async function redeemTicket(
  env: Env,
  ticket: string,
  _purpose: TicketPurpose,
): Promise<Player | null> {
  return devPlayer(env, ticket)
}

/** STUB (stream A): is this leaderboard name key owned by an account? */
export async function isNameOwned(env: Env, nameKey: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS owned FROM accounts WHERE name_key = ?')
      .bind(nameKey)
      .first<{ owned: number }>()
    return row !== null
  } catch {
    return false
  }
}

// --- stream C ------------------------------------------------------------------------------------

export type LedgerKind =
  | 'start_grant'
  | 'gauntlet_clear'
  | 'duel_win'
  | 'duel_loss'
  | 'ghost_win'
  | 'ghost_royalty'
  | 'ffa_kill_mint'
  | 'ffa_deposit'
  | 'ffa_strongbox'
  | 'ffa_commission'
  | 'store_purchase'
  | 'level_reward'
  | 'admin_adjust'

export interface LedgerEntry {
  accountId: string
  kind: LedgerKind
  amount: number
  xp?: number
  ref?: string
}

/** STUB (stream C): purse and XP updates plus ledger rows, keyed `<idemKey>#<index>`. */
export function ledgerStatements(
  env: Env,
  idemKey: string,
  entries: readonly LedgerEntry[],
): D1PreparedStatement[] {
  const now = Date.now()
  return entries.flatMap((entry, i) => [
    env.DB.prepare(
      `INSERT INTO ledger (account_id, delta, kind, ref, idem_key, xp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      entry.accountId,
      entry.amount,
      entry.kind,
      entry.ref ?? null,
      `${idemKey}#${i}`,
      entry.xp ?? 0,
      now,
    ),
    env.DB.prepare('UPDATE profiles SET purse = purse + ?, xp = xp + ? WHERE account_id = ?').bind(
      entry.amount,
      entry.xp ?? 0,
      entry.accountId,
    ),
  ])
}

export interface Loadout {
  gun: string
  hat: string
  outfit: string
  spurs: string
  holster: string
  frame: string
  drawSound: string
  saddlebag: string
  extra: string | null
}

export const DEFAULT_LOADOUT: Loadout = {
  gun: 'rusty-six',
  hat: 'battered-brim',
  outfit: 'trail-duds',
  spurs: 'plain-rowels',
  holster: 'plain-leather',
  frame: 'pine-board',
  drawSound: 'standard-report',
  saddlebag: 'plain-sack',
  extra: null,
}

/** STUB (stream C). */
export function normalizeLoadout(value: unknown): Loadout {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_LOADOUT
  }
  return { ...DEFAULT_LOADOUT, ...(value as Partial<Loadout>) }
}

export interface Profile {
  accountId: string
  name: string
  purse: number
  xp: number
  level: number
  prestige: number
  loadout: Loadout
}

/** STUB (stream C). */
export async function getProfile(env: Env, accountId: string): Promise<Profile | null> {
  const row = await env.DB.prepare(
    'SELECT account_id, name, purse, xp, level, prestige, loadout FROM profiles WHERE account_id = ?',
  )
    .bind(accountId)
    .first<{
      account_id: string
      name: string
      purse: number
      xp: number
      level: number
      prestige: number
      loadout: string
    }>()
  if (!row) {
    return null
  }
  let loadout: unknown = null
  try {
    loadout = JSON.parse(row.loadout)
  } catch {
    loadout = null
  }
  return {
    accountId: row.account_id,
    name: row.name,
    purse: row.purse,
    xp: row.xp,
    level: row.level,
    prestige: row.prestige,
    loadout: normalizeLoadout(loadout),
  }
}

/** STUB (stream C): first clear 40 + 15·i XP and 10% of the poster, else 10 XP. */
export async function gauntletClearStatements(
  env: Env,
  accountId: string,
  level: number,
  runId: string,
): Promise<D1PreparedStatement[]> {
  return ledgerStatements(env, `gauntlet:repeat:${runId}:${level}`, [
    { accountId, kind: 'gauntlet_clear', amount: 0, xp: 10, ref: runId },
  ])
}

// --- stream C: data/progression.ts (pure) --------------------------------------------------------

const round5 = (n: number): number => Math.round(n / 5) * 5

/** STUB (progression.ts). */
export function baseBounty(level: number, prestige = 0): number {
  return round5(50 * 1.065 ** (level - 1) * (1 + 0.2 * prestige))
}

/** STUB (progression.ts): the live bounty. */
export function bountyForLevel(level: number, streak = 0, prestige = 0): number {
  return round5(baseBounty(level, prestige) * (1 + 0.1 * Math.min(streak, 5)))
}

const speedPct = (ms: number | null): number => {
  if (ms === null) {
    return 0
  }
  if (ms < 180) {
    return 0.15
  }
  if (ms < 220) {
    return 0.08
  }
  return ms < 300 ? 0.03 : 0
}

/** STUB (progression.ts). */
export function duelPayout(o: {
  loserBounty: number
  reactionMs: number | null
  pairFactor?: number
  ghost?: boolean
}): number {
  const factor = (o.pairFactor ?? 1) * (o.ghost ? 0.5 : 1)
  return Math.round(
    o.loserBounty * factor + o.loserBounty * speedPct(o.reactionMs) * (o.pairFactor ?? 1),
  )
}

/** STUB (progression.ts). */
export function lossPenalty(purse: number, bounty: number): number {
  if (purse <= 100) {
    return 0
  }
  return Math.round(Math.min(Math.min(Math.max(0.04 * purse, 10), 0.6 * bounty), purse - 100))
}

/** STUB (progression.ts). */
export function duelPenalty(
  purse: number,
  loserBounty: number,
  o: { pairFactor?: number; ghost?: boolean; dodge?: boolean } = {},
): number {
  const factor = (o.pairFactor ?? 1) * (o.ghost ? 0.5 : 1) * (o.dodge ? 0.5 : 1)
  return Math.min(Math.round(lossPenalty(purse, loserBounty) * factor), Math.max(0, purse - 100))
}

export type DuelXpResult = 'win' | 'loss' | 'dead_heat' | 'froze' | 'coward' | 'forfeit' | 'dodge'

const BASE_XP: Readonly<Record<DuelXpResult, number>> = {
  win: 100,
  loss: 40,
  dead_heat: 50,
  froze: 25,
  coward: 0,
  forfeit: 0,
  dodge: 0,
}

/** STUB (progression.ts). */
export function duelXp(o: {
  result: DuelXpResult
  reactionMs: number | null
  ghost?: boolean
  pairFactor?: number
}): number {
  let xp = BASE_XP[o.result]
  if ((o.result === 'win' || o.result === 'loss') && o.reactionMs !== null) {
    if (o.reactionMs < 180) {
      xp += 40
    } else if (o.reactionMs < 220) {
      xp += 20
    }
  }
  xp *= o.ghost ? 0.6 : 1
  const pf = o.pairFactor ?? 1
  return xp > 0 ? Math.max(pf === 0 ? 10 : 0, Math.round(xp * pf)) : 0
}

/** STUB (progression.ts): 100%, 100%, 50%, 25%, then 0. */
export function pairFactor(matchNumberInLast24h: number): number {
  return [1, 1, 1, 0.5, 0.25][matchNumberInLast24h] ?? (matchNumberInLast24h < 1 ? 1 : 0)
}

const STREAK_MULTIPLIER: Readonly<Record<number, number>> = { 3: 1, 5: 2, 10: 4 }

/** STUB (progression.ts): 1×, 2×, 4× base bounty on the 3rd, 5th and 10th win. */
export function streakBonus(streakAfterWin: number, base: number): number {
  return base * (STREAK_MULTIPLIER[streakAfterWin] ?? 0)
}

/** STUB (progression.ts): $5 + 10% of the penalty, capped at $250 a day. */
export function ghostRoyalty(penalty: number, royaltiesToday: number): number {
  return Math.max(0, Math.min(5 + Math.round(penalty * 0.1), 250 - royaltiesToday))
}

/** STUB (progression.ts). */
export const DAILY_FIRST_WIN_XP = 200

/** STUB (progression.ts). */
export function dailyWinBonus(base: number): number {
  return 2 * base
}

// biome-ignore-end lint/suspicious/useAwait: stubs mirror async signatures
