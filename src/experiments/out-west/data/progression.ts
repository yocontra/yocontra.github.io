/**
 * Levels, XP, bounties and every money formula, shared by all modes, the client and the Worker.
 * Pure: no imports outside `data/`. Owned by stream C. All money is whole dollars.
 *
 * The server computes every number that moves money or XP with these functions; the client uses
 * them only to preview. Bump PROGRESSION_VERSION whenever a rule changes.
 */
import { BOUNTIES } from './economy.ts'

export const PROGRESSION_VERSION = 1
export const MAX_LEVEL = 50
export const MAX_PRESTIGE = 5
/** Dollars every new account starts with (plus the eight starter items). */
export const START_PURSE = 250

// ─── XP curve ──────────────────────────────────────────────────────────────────────────────────

const clampLevel = (level: number): number =>
  Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number.isFinite(level) ? level : 1)))

/** XP needed to go from `level` to `level + 1`: 150 + 80·(L − 1). 0 at the cap. */
export function xpToNext(level: number): number {
  const l = clampLevel(level)
  return l >= MAX_LEVEL ? 0 : 150 + 80 * (l - 1)
}

/** Cumulative XP at which `level` is reached. L1 = 0, L5 = 1,080, L50 = 101,430. */
export function xpForLevel(level: number): number {
  const n = clampLevel(level) - 1
  return 150 * n + 40 * n * (n - 1)
}

/** Every level threshold, index 0 = L1. Used by the ledger's SQL to level up inside a batch. */
export const LEVEL_THRESHOLDS: readonly number[] = Array.from({ length: MAX_LEVEL }, (_, i) =>
  xpForLevel(i + 1),
)

/** The level for a lifetime XP total (since the last prestige), capped at 50. */
export function levelForXp(xp: number): number {
  let level = 1
  for (const [i, threshold] of LEVEL_THRESHOLDS.entries()) {
    if (xp >= threshold) {
      level = i + 1
    }
  }
  return level
}

/** Progress within the current level, for the hub's XP bar. */
export function levelProgress(xp: number): { level: number; into: number; next: number } {
  const level = levelForXp(xp)
  return { level, into: xp - xpForLevel(level), next: xpToNext(level) }
}

// ─── Level rewards and titles ──────────────────────────────────────────────────────────────────

/** Each level-up pays $25 × the new level. Sum for going from `from` to `to`. */
export function levelRewards(from: number, to: number): number {
  const tri = (n: number): number => (n * (n + 1)) / 2
  const a = clampLevel(from)
  const b = clampLevel(to)
  return b > a ? 25 * (tri(b) - tri(a)) : 0
}

export const TITLES: readonly { readonly level: number; readonly title: string }[] = [
  { level: 1, title: 'Greenhorn' },
  { level: 5, title: 'Drifter' },
  { level: 10, title: 'Gunhand' },
  { level: 20, title: 'Regulator' },
  { level: 30, title: 'Shootist' },
  { level: 40, title: 'Pistolero' },
  { level: 50, title: 'Legend of the West' },
]

export function titleFor(level: number): string {
  let title = 'Greenhorn'
  for (const t of TITLES) {
    if (level >= t.level) {
      title = t.title
    }
  }
  return title
}

// ─── Prestige ("Ride Again") ───────────────────────────────────────────────────────────────────

export const canPrestige = (level: number, prestige: number): boolean =>
  level >= MAX_LEVEL && prestige < MAX_PRESTIGE

/** Matchmaking level: min(50, L + 10·prestige). */
export const effectiveLevel = (level: number, prestige: number): number =>
  Math.min(MAX_LEVEL, clampLevel(level) + 10 * Math.max(0, prestige))

// ─── Bounties ──────────────────────────────────────────────────────────────────────────────────

const round5 = (n: number): number => Math.round(n / 5) * 5

/** round5(50 · 1.065^(L−1) · (1 + 0.2·p)). L1 $50 · L10 $90 · L20 $165 · L30 $310 · L50 $1,095. */
export function baseBounty(level: number, prestige = 0): number {
  const p = Math.min(MAX_PRESTIGE, Math.max(0, Math.floor(prestige)))
  return round5(50 * 1.065 ** (clampLevel(level) - 1) * (1 + 0.2 * p))
}

/** The live bounty on a poster: base × (1 + 0.10·min(streak, 5)), so a hot streak adds up to 50%. */
export function bountyForLevel(level: number, streak = 0, prestige = 0): number {
  const s = Math.min(5, Math.max(0, Math.floor(streak)))
  return round5(baseBounty(level, prestige) * (1 + 0.1 * s))
}

// ─── Bounty Hunt duels ─────────────────────────────────────────────────────────────────────────

/** Below this a shot is anticipation, not reaction (it counts as cowardice). */
export const MIN_REACTION_MS = 100
/** The money a loser can never drop below through penalties. */
export const PURSE_RESERVE = 100

/** Speed-bonus share of the loser's live bounty, fastest first. */
export const SPEED_BONUS: readonly { readonly ms: number; readonly pct: number }[] = [
  { ms: 180, pct: 0.15 },
  { ms: 220, pct: 0.08 },
  { ms: 300, pct: 0.03 },
]

/** Pair diminishing returns over a rolling 24 h: 1st and 2nd match 100%, 3rd 50%, 4th 25%, 5th+ 0. */
export function pairFactor(matchNumber: number): number {
  if (matchNumber <= 2) {
    return 1
  }
  if (matchNumber === 3) {
    return 0.5
  }
  return matchNumber === 4 ? 0.25 : 0
}

export function speedBonus(loserBounty: number, reactionMs: number | null): number {
  if (reactionMs === null || !Number.isFinite(reactionMs) || reactionMs < MIN_REACTION_MS) {
    return 0
  }
  const tier = SPEED_BONUS.find((t) => reactionMs < t.ms)
  return tier ? Math.round(loserBounty * tier.pct) : 0
}

export interface PayoutInput {
  /** The loser's live bounty, or for a ghost win the ghost's base bounty. */
  loserBounty: number
  /** The winner's judged reaction. */
  reactionMs: number | null
  pairFactor?: number
  ghost?: boolean
}

/** Winner's payout: (bounty × (1.0 human | 0.5 ghost) + speedBonus) × pairFactor. */
export function duelPayout(o: PayoutInput): number {
  const pf = o.pairFactor ?? 1
  const share = o.ghost === true ? 0.5 : 1
  return Math.round((o.loserBounty * share + speedBonus(o.loserBounty, o.reactionMs)) * pf)
}

/**
 * The raw loss penalty from the spec, with `bounty` the loser's own live bounty:
 * purse ≤ 100 ? 0 : min(clamp(0.04·purse, 10, 0.6·bounty), purse − 100).
 */
export function lossPenalty(purse: number, bounty: number): number {
  if (purse <= PURSE_RESERVE) {
    return 0
  }
  const cap = 0.6 * bounty
  const pct = Math.min(Math.max(0.04 * purse, 10), cap)
  return Math.max(0, Math.round(Math.min(pct, purse - PURSE_RESERVE)))
}

/** The penalty actually charged: raw × pairFactor, ×0.5 against a ghost, ×0.5 for a dodge. */
export function duelPenalty(
  purse: number,
  loserBounty: number,
  o: { pairFactor?: number; ghost?: boolean; dodge?: boolean } = {},
): number {
  let factor = o.pairFactor ?? 1
  if (o.ghost === true) {
    factor *= 0.5
  }
  if (o.dodge === true) {
    factor *= 0.5
  }
  return Math.round(lossPenalty(purse, loserBounty) * factor)
}

/** Streak bonuses on the 3rd, 5th and 10th win in a row pay 1×, 2× and 4× your own base bounty. */
export function streakBonus(streakAfterWin: number, ownBaseBounty: number): number {
  const mult: Record<number, number> = { 3: 1, 5: 2, 10: 4 }
  return (mult[streakAfterWin] ?? 0) * ownBaseBounty
}

/** First win of the day pays 2× your base bounty (plus DAILY_FIRST_WIN_XP). */
export const dailyWinBonus = (ownBaseBounty: number): number => 2 * ownBaseBounty
export const DAILY_FIRST_WIN_XP = 200

export type DuelResult = 'win' | 'loss' | 'dead_heat' | 'froze' | 'coward' | 'forfeit' | 'dodge'

export const DUEL_XP = {
  win: 100,
  loss: 40,
  dead_heat: 50,
  froze: 25,
  coward: 0,
  forfeit: 0,
  dodge: 0,
  speed180: 40,
  speed220: 20,
  ghostFactor: 0.6,
  pairFloor: 10,
} as const

/** XP for one duel. Speed bonus applies to wins and losses where you fired after the call. */
export function duelXp(o: {
  result: DuelResult
  reactionMs: number | null
  ghost?: boolean
  pairFactor?: number
}): number {
  let xp: number = DUEL_XP[o.result]
  const fired = o.reactionMs !== null && o.reactionMs >= MIN_REACTION_MS
  if (xp > 0 && fired && (o.result === 'win' || o.result === 'loss')) {
    const ms = o.reactionMs ?? Number.POSITIVE_INFINITY
    if (ms < 180) {
      xp += DUEL_XP.speed180
    } else if (ms < 220) {
      xp += DUEL_XP.speed220
    }
  }
  if (o.ghost === true) {
    xp *= DUEL_XP.ghostFactor
  }
  const pf = o.pairFactor ?? 1
  if (xp > 0 && pf < 1) {
    xp = Math.max(DUEL_XP.pairFloor, xp * pf)
  }
  return Math.round(xp)
}

// ─── Ghosts ────────────────────────────────────────────────────────────────────────────────────

/** Ghost cash payouts stop after this many ghost wins in a UTC day (XP still pays). */
export const GHOST_CASH_WINS_PER_DAY = 30
export const ROYALTY_CAP_PER_DAY = 250

/** The ghost owner's royalty when their ghost wins: $5 + 10% of the loser's penalty, ≤ $250/day. */
export function ghostRoyalty(loserPenalty: number, royaltiesToday: number): number {
  const room = Math.max(0, ROYALTY_CAP_PER_DAY - royaltiesToday)
  return Math.min(room, 5 + Math.round(0.1 * Math.max(0, loserPenalty)))
}

// ─── Gauntlet (signed-in ranked runs) ──────────────────────────────────────────────────────────

/** Repeat-win XP on the first outlaw; later outlaws pay more ({@link gauntletRepeatXp}). */
export const GAUNTLET_REPEAT_XP = 10
/** Daily cap on repeat-win XP (raised from 200 so solo play keeps paying). */
export const GAUNTLET_REPEAT_XP_PER_DAY = 600

/** Repeat win over outlaw `i` (0-based): 10 + 2·i XP, so a full repeat run pays 442 XP. */
export const gauntletRepeatXp = (i: number): number =>
  GAUNTLET_REPEAT_XP + 2 * Math.min(16, Math.max(0, Math.floor(Number.isFinite(i) ? i : 0)))

/** First clear of outlaw `i` (0-based): 40 + 15·i XP. 2,720 XP over all 17. */
export const gauntletFirstClearXp = (i: number): number => 40 + 15 * i

/** First clear of outlaw `i` pays 10% of his poster. */
export const gauntletFirstClearCash = (i: number): number => Math.round(0.1 * (BOUNTIES[i] ?? 0))

// ─── Frontier FFA ──────────────────────────────────────────────────────────────────────────────

export const FFA_XP = {
  kill: 30,
  assist: 10,
  deadEyeKill: 10,
  showdownWin: 60,
  strongbox: 50,
  bankPer10: 1,
} as const

/** Minted into the killer's carried cash: 25% of the victim's base bounty, +50% if Most Wanted. */
export function ffaKillMint(victimLevel: number, victimPrestige = 0, mostWanted = false): number {
  const mint = Math.floor(0.25 * baseBounty(victimLevel, victimPrestige))
  return mostWanted ? Math.floor(mint * 1.5) : mint
}

/** On death 70% of carry drops (at least $10 if any), the rest burns. A showdown loss drops 100%. */
export function ffaDeathDrop(carried: number, showdown = false): { drop: number; burn: number } {
  const c = Math.max(0, Math.floor(carried))
  if (showdown) {
    return { drop: c, burn: 0 }
  }
  const drop = Math.min(c, Math.max(10, Math.round(0.7 * c)))
  return { drop, burn: c - drop }
}

/** Banker's commission: +10% on a single deposit of $500 or more, capped at $300. */
export function ffaDepositCommission(amount: number): number {
  return amount >= 500 ? Math.min(300, Math.floor(0.1 * amount)) : 0
}

/** Strongbox value: $400 + $20 × players in the lobby. */
export const ffaStrongbox = (playersInLobby: number): number =>
  400 + 20 * Math.max(0, Math.floor(playersInLobby))

/** Banking XP: 1 per $10 banked. */
export const ffaBankXp = (amount: number): number => Math.floor(Math.max(0, amount) / 10)

/** The Most Wanted marker goes to the top carrier holding at least this much. */
export const MOST_WANTED_MIN_CARRY = 300

/** Hard upper bound on any single Bounty Hunt payout: liveBounty(L50, streak 5) × 1.15. */
export const MAX_DUEL_PAYOUT = Math.round(bountyForLevel(MAX_LEVEL, 5) * 1.15)

// ─── Solo levels and the Outfitter's gates ─────────────────────────────────────────────────────

/**
 * Levels earned in single player count more toward the Outfitter's level gates: gates are about
 * 0.3× for them. Solo XP is the gauntlet's own (first clears, repeats, medals, challenges, the Daily
 * Outlaw, a guest's migrated purse), kept in `profiles.solo_xp`.
 */
export const SOLO_GATE_FACTOR = 0.3

/**
 * The level the Outfitter checks gates against: your level, plus the levels solo XP earned you
 * scaled by 1/0.3 − 1. A player at L11 entirely from the gauntlet shops as L35. Capped at 50.
 */
export function storeLevel(p: { level: number; xp: number; soloXp: number }): number {
  const level = clampLevel(p.level)
  const solo = Math.min(Math.max(0, Math.floor(p.soloXp || 0)), Math.max(0, p.xp))
  const without = Math.min(level, levelForXp(Math.max(0, p.xp - solo)))
  const gained = level - without
  return Math.min(MAX_LEVEL, level + Math.ceil(gained * (1 / SOLO_GATE_FACTOR - 1) - 1e-9))
}
