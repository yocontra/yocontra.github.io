/**
 * Settlement of one Bounty Hunt duel: who gets what, as one D1 batch (match row + ledger + stats +
 * ghost samples + pair stats + royalty). Money and XP come from stream C's pure progression rules.
 * Idempotent: the match row's primary key and the ledger's `match:<id>` idempotency keys make a
 * retried batch fail as a whole instead of paying twice.
 */
import type { MatchOutcome, Settlement } from '../../../src/experiments/out-west/contract/duel.ts'
import {
  baseBounty,
  bountyForLevel,
  DAILY_FIRST_WIN_XP,
  type DuelResult as DuelXpResult,
  dailyWinBonus,
  duelPayout,
  duelPenalty,
  duelXp,
  GHOST_CASH_WINS_PER_DAY,
  ghostRoyalty,
  levelForXp,
  levelRewards,
  streakBonus,
} from '../../../src/experiments/out-west/data/progression.ts'
import type { Env } from '../env.ts'
import { looksAutomated } from '../judge.ts'
import { grantItemStatement, type LedgerEntry, ledgerStatements, type Profile } from './external.ts'
import { drawRating, ghostRecordStatements } from './ghost.ts'
import type { Pair, Seat } from './judge-pvp.ts'
import type { WaitStats } from './standoff.ts'
import { type DuelStats, duelStatsStatement, utcDay } from './stats.ts'

const DODGE_WINDOW_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Public cowardice tally that earns the Yellow Hat. */
export const YELLOW_HAT_COWARDICE = 10

export const FLAG_RTT_CAPPED = 1
export const FLAG_ROUGH_TRAIL = 2
export const FLAG_SUSPICIOUS = 4

export interface HumanSeat {
  accountId: string
  profile: Profile
  stats: DuelStats
  /** In the Badlands (§8): winnings are frozen (booked as $0); losses and XP still apply. */
  frozen?: boolean
}

export interface GhostSeat {
  /** The ghost's owner, or null for a Town Outlaw. */
  ownerId: string | null
  level: number
  prestige: number
  royaltiesToday: number
}

export interface SettleInput {
  /** `<room id>:<rematch>`; also the ledger idempotency key suffix. */
  matchId: string
  rematch: number
  mode: 'pvp' | 'ghost'
  outcome: MatchOutcome
  winner: Seat | null
  culprit: Seat | null
  reactions: Pair<number | null>
  deadHeats: number
  /** Seat 1 is null in a ghost duel. */
  humans: readonly [HumanSeat, HumanSeat | null]
  ghost: GhostSeat | null
  wait: WaitStats | null
  rtts: Pair<number | null>
  flags: number
  /** Match number for this pair in the last 24 h (1 for the first). */
  pairMatchNumber: number
  pairFactor: number
  /** The pair's recent match times, for the pair_stats row. */
  pairRecent: readonly number[]
  startedAt: number
  now: number
}

export interface SettleOutput {
  statements: D1PreparedStatement[]
  settlements: [Settlement | null, Settlement | null]
}

type Line = Settlement['lines'][number]

/** What each seat's duel counts as for XP. */
function seatResult(input: SettleInput, seat: Seat): DuelXpResult {
  switch (input.outcome) {
    case 'win':
      return input.winner === seat ? 'win' : 'loss'
    case 'coward':
    case 'forfeit':
    case 'dodge':
      if (input.culprit === seat) {
        return input.outcome
      }
      // The honest player of a dodge is simply requeued; of a coward or forfeit, wins.
      return input.outcome === 'dodge' ? 'dodge' : 'win'
    case 'draw':
      return 'dead_heat'
    default:
      return 'froze'
  }
}

interface SeatMoney {
  entries: LedgerEntry[]
  lines: Line[]
  delta: number
  xp: number
  stats: DuelStats
  /** Penalty taken (for a ghost owner's royalty). */
  penalty: number
}

function liveBountyOf(h: HumanSeat): number {
  return bountyForLevel(h.profile.level, h.stats.streak, h.profile.prestige)
}

/** The loser's bounty a winner is paid from. */
function opponentBounty(input: SettleInput, seat: Seat): number {
  const other = input.humans[seat === 0 ? 1 : 0]
  if (other) {
    return liveBountyOf(other)
  }
  const ghost = input.ghost
  return ghost ? baseBounty(ghost.level, ghost.prestige) : baseBounty(1)
}

function winnerMoney(input: SettleInput, seat: Seat, h: HumanSeat, money: SeatMoney): void {
  const ghostDuel = input.mode === 'ghost'
  const ref = input.matchId
  const today = utcDay(input.now)
  const ghostCapped = ghostDuel && h.stats.ghostWinsToday >= GHOST_CASH_WINS_PER_DAY
  const reaction = input.outcome === 'win' ? input.reactions[seat] : null
  const payout = ghostCapped
    ? 0
    : duelPayout({
        loserBounty: opponentBounty(input, seat),
        reactionMs: reaction,
        pairFactor: input.pairFactor,
        ghost: ghostDuel,
      })
  const xp = duelXp({
    result: 'win',
    reactionMs: reaction,
    ghost: ghostDuel,
    pairFactor: input.pairFactor,
  })
  money.entries.push({
    accountId: h.accountId,
    kind: ghostDuel ? 'ghost_win' : 'duel_win',
    amount: payout,
    xp,
    ref,
  })
  money.lines.push({ label: ghostDuel ? 'Ghost bounty' : 'Bounty', amount: payout, xp })

  const streak = h.stats.streak + 1
  const base = baseBounty(h.profile.level, h.profile.prestige)
  const bonus = ghostCapped ? 0 : Math.round(streakBonus(streak, base) * input.pairFactor)
  if (bonus > 0) {
    money.entries.push({
      accountId: h.accountId,
      kind: 'duel_win',
      amount: bonus,
      ref: `${ref}:streak`,
    })
    money.lines.push({ label: `${streak}-win streak`, amount: bonus, xp: 0 })
  }
  if (h.stats.lastWinDay !== today && input.pairFactor > 0) {
    const daily = ghostCapped ? 0 : Math.round(dailyWinBonus(base) * input.pairFactor)
    money.entries.push({
      accountId: h.accountId,
      kind: 'duel_win',
      amount: daily,
      xp: DAILY_FIRST_WIN_XP,
      ref: `${ref}:daily`,
    })
    money.lines.push({ label: 'First win of the day', amount: daily, xp: DAILY_FIRST_WIN_XP })
  }
  money.stats = {
    ...money.stats,
    streak,
    bestStreak: Math.max(h.stats.bestStreak, streak),
    wins: h.stats.wins + 1,
    lastWinDay: today,
    ghostWinsToday: h.stats.ghostWinsToday + (ghostDuel ? 1 : 0),
  }
}

/** One human seat's view of a settlement. */
interface SeatTurn {
  input: SettleInput
  seat: Seat
  h: HumanSeat
}

function loserMoney({ input, seat, h }: SeatTurn, result: DuelXpResult, money: SeatMoney): void {
  const ghostDuel = input.mode === 'ghost'
  const penalty = duelPenalty(h.profile.purse, liveBountyOf(h), {
    pairFactor: input.pairFactor,
    ghost: ghostDuel,
    dodge: result === 'dodge',
  })
  const fired = input.reactions[seat] !== null
  const xp =
    result === 'loss' && fired
      ? duelXp({
          result,
          reactionMs: input.reactions[seat] ?? null,
          ghost: ghostDuel,
          pairFactor: input.pairFactor,
        })
      : 0
  money.penalty = penalty
  money.entries.push({
    accountId: h.accountId,
    kind: 'duel_loss',
    amount: -penalty,
    xp,
    ref: input.matchId,
  })
  const label = { loss: 'Loss', coward: 'Drew early', forfeit: 'Forfeit', dodge: 'Dodged' }[
    result as 'loss' | 'coward' | 'forfeit' | 'dodge'
  ]
  money.lines.push({ label: label ?? 'Loss', amount: -penalty, xp })
  money.stats = {
    ...money.stats,
    streak: 0,
    losses: h.stats.losses + (result === 'dodge' ? 0 : 1),
    cowardice: h.stats.cowardice + (result === 'coward' ? 1 : 0),
    dodges:
      result === 'dodge'
        ? [...h.stats.dodges.filter((t) => t > input.now - DODGE_WINDOW_MS), input.now]
        : h.stats.dodges,
  }
}

function seatMoney(input: SettleInput, seat: Seat, h: HumanSeat): SeatMoney {
  const result = seatResult(input, seat)
  const money: SeatMoney = {
    entries: [],
    lines: [],
    delta: 0,
    xp: 0,
    stats: { ...h.stats },
    penalty: 0,
  }
  if (result === 'win') {
    winnerMoney(input, seat, h, money)
  } else if (result === 'dead_heat' || result === 'froze') {
    // Draws pay XP only.
    const xp = duelXp({
      result,
      reactionMs: null,
      ghost: input.mode === 'ghost',
      pairFactor: input.pairFactor,
    })
    money.entries.push({
      accountId: h.accountId,
      kind: result === 'froze' ? 'duel_froze' : 'duel_draw',
      amount: 0,
      xp,
      ref: input.matchId,
    })
    money.lines.push({ label: result === 'froze' ? 'No one drew' : 'Tie', amount: 0, xp })
    money.stats = { ...money.stats, draws: h.stats.draws + 1 }
  } else if (result === 'dodge' && input.culprit !== seat) {
    // The dodged player: nothing moves. They are requeued at the front.
  } else {
    loserMoney({ input, seat, h }, result, money)
  }
  const reaction = input.reactions[seat]
  if (reaction !== null && input.outcome !== 'coward') {
    const recent = [...money.stats.recent, reaction].slice(-30)
    money.stats = { ...money.stats, recent, drawRating: drawRating(recent) }
  }
  if (h.frozen) {
    money.entries = money.entries.map((e) => (e.amount > 0 ? { ...e, amount: 0 } : e))
    money.lines = money.lines.map((l) => (l.amount > 0 ? { ...l, amount: 0 } : l))
  }
  money.delta = money.entries.reduce((sum, e) => sum + e.amount, 0)
  money.xp = money.entries.reduce((sum, e) => sum + (e.xp ?? 0), 0)
  return money
}

function ghostObservation(
  env: Env,
  { input, seat, h }: SeatTurn,
  stats: DuelStats,
): D1PreparedStatement[] {
  // Only judged evidence: a dodge or a forfeit says nothing about how a player draws.
  if (input.outcome === 'dodge' || (input.outcome === 'forfeit' && input.culprit === seat)) {
    return []
  }
  const coward = input.wait?.coward ?? null
  const mine = coward?.seat === seat
  return ghostRecordStatements(env, {
    accountId: h.accountId,
    source: input.mode,
    reactionMs: input.outcome === 'coward' ? null : input.reactions[seat],
    froze: input.outcome === 'froze',
    fakesSeen: input.wait?.fakesSeen ?? 0,
    fakeCoward: mine && (coward?.onCue ?? false),
    waitCoward: mine && !(coward?.onCue ?? false),
    waitedMs: input.wait?.waitedMs ?? 0,
    snapshot: {
      name: h.profile.name,
      level: h.profile.level,
      prestige: h.profile.prestige,
      loadout: h.profile.loadout,
      drawRating: stats.drawRating,
    },
  })
}

type BaseSettlement = Omit<
  Settlement,
  'xpBefore' | 'xpAfter' | 'levelBefore' | 'levelAfter' | 'levelReward'
>

/**
 * Adds the level-up to a seat's settlement: XP and level before and after (from the profile the
 * settlement was built on), and the `$25 × level` reward the ledger books in the same batch for
 * every level gained, as its own `Level up · Lv N` line. The reward is counted once per duel, from
 * this duel's XP only, so rematches can't accumulate it.
 */
export function withLevelUp(
  base: BaseSettlement,
  before: { xp: number; level: number },
  booked?: number,
): Settlement {
  const xpAfter = before.xp + base.xp
  const levelAfter = Math.max(before.level, levelForXp(xpAfter))
  const levelReward = booked ?? levelRewards(before.level, levelAfter)
  const lines =
    levelReward > 0
      ? [...base.lines, { label: `Level up · Lv ${levelAfter}`, amount: levelReward, xp: 0 }]
      : base.lines
  return {
    ...base,
    delta: base.delta + levelReward,
    lines,
    xpBefore: before.xp,
    xpAfter,
    levelBefore: before.level,
    levelAfter,
    levelReward,
  }
}

/** Swaps the predicted level reward for the one the ledger actually booked. */
export function reconcileLevelReward(s: Settlement, booked: number): Settlement {
  if (booked === s.levelReward) {
    return s
  }
  const lines = s.lines.filter((l) => !l.label.startsWith('Level up'))
  const base = { ...s, delta: s.delta - s.levelReward, lines }
  return withLevelUp(base, { xp: s.xpBefore, level: s.levelBefore }, booked)
}

/** SQL: the level reward the ledger booked for one account in one match's batch. */
export const BOOKED_LEVEL_REWARD = `SELECT COALESCE(SUM(delta), 0) AS reward FROM ledger
  WHERE account_id = ?1 AND kind = 'level_reward' AND substr(idem_key, 1, length(?2)) = ?2`

export function buildSettlement(env: Env, input: SettleInput): SettleOutput {
  const settlements: [Settlement | null, Settlement | null] = [null, null]
  const perSeat: (SeatMoney | null)[] = [null, null]
  const entries: LedgerEntry[] = []
  const side: D1PreparedStatement[] = []
  for (const seat of [0, 1] as const) {
    const h = input.humans[seat]
    if (!h) {
      continue
    }
    const money = seatMoney(input, seat, h)
    perSeat[seat] = money
    entries.push(...money.entries.filter((e) => e.amount !== 0 || (e.xp ?? 0) !== 0))
    side.push(duelStatsStatement(env, h.accountId, money.stats))
    if (money.stats.cowardice >= YELLOW_HAT_COWARDICE) {
      // The Yellow Hat (§7): a reward for drawing early 10 times. Idempotent.
      side.push(grantItemStatement(env, h.accountId, 'hat.yellow'))
    }
    side.push(...ghostObservation(env, { input, seat, h }, money.stats))
    settlements[seat] = withLevelUp(
      {
        delta: money.delta,
        xp: money.xp,
        purse: h.profile.purse + money.delta,
        streak: money.stats.streak,
        pairFactor: input.pairFactor,
        lines: money.lines,
      },
      h.profile,
    )
  }
  // Royalty: a ghost that wins pays its owner $5 + 10% of the loser's penalty (capped daily).
  const human = perSeat[0]
  const ghost = input.ghost
  if (ghost?.ownerId && human && input.winner === 1 && human.penalty >= 0) {
    const royalty = ghostRoyalty(human.penalty, ghost.royaltiesToday)
    if (royalty > 0) {
      entries.push({
        accountId: ghost.ownerId,
        kind: 'ghost_royalty',
        amount: royalty,
        ref: input.matchId,
      })
      side.push(
        env.DB.prepare(
          `UPDATE ghost_profiles SET
             royalties_today = CASE WHEN royalties_day = ?2 THEN royalties_today + ?3 ELSE ?3 END,
             royalties_day = ?2
           WHERE account_id = ?1`,
        ).bind(ghost.ownerId, utcDay(input.now), royalty),
      )
    }
  }
  const statements = [
    matchRow(env, input, perSeat),
    ...ledgerStatements(env, `match:${input.matchId}`, entries),
    ...side,
    ...pairRow(env, input),
  ]
  return { statements, settlements }
}

function matchRow(
  env: Env,
  input: SettleInput,
  perSeat: (SeatMoney | null)[],
): D1PreparedStatement {
  const suspicious = input.humans.some((h, i) => {
    const s = perSeat[i]?.stats ?? h?.stats
    return s ? s.recent.length >= 20 && looksAutomated(s.recent.slice(-20)) : false
  })
  const flags = input.flags | (suspicious ? FLAG_SUSPICIOUS : 0)
  const winner = input.winner === null ? null : (['a', 'b'] as const)[input.winner]
  return env.DB.prepare(
    `INSERT INTO matches (id, mode, a_id, b_id, ghost_of, winner, outcome, a_ms, b_ms, a_rtt, b_rtt,
       dead_heats, a_delta, b_delta, a_xp, b_xp, pair_factor, flags, rematch, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.matchId,
    input.mode,
    input.humans[0].accountId,
    input.humans[1]?.accountId ?? null,
    input.ghost?.ownerId ?? null,
    winner,
    input.outcome,
    input.reactions[0],
    input.reactions[1],
    input.rtts[0] === null ? null : Math.round(input.rtts[0]),
    input.rtts[1] === null ? null : Math.round(input.rtts[1]),
    input.deadHeats,
    perSeat[0]?.delta ?? 0,
    perSeat[1]?.delta ?? null,
    perSeat[0]?.xp ?? 0,
    perSeat[1]?.xp ?? null,
    input.pairFactor,
    flags,
    input.rematch,
    input.startedAt,
    Math.max(input.now, input.startedAt),
  )
}

/** The pair's rolling 24 h record (PvP only). */
function pairRow(env: Env, input: SettleInput): D1PreparedStatement[] {
  const a = input.humans[0].accountId
  const b = input.humans[1]?.accountId
  if (input.mode !== 'pvp' || !b) {
    return []
  }
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const recent = [...input.pairRecent.filter((t) => t > input.now - DAY_MS), input.now].slice(-10)
  return [
    env.DB.prepare(
      `INSERT INTO pair_stats (a_id, b_id, recent, last_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (a_id, b_id) DO UPDATE SET recent = ?3, last_at = ?4`,
    ).bind(lo, hi, JSON.stringify(recent), input.now),
  ]
}

/** The pair's recent match times and this match's number in the rolling 24 h. */
export async function pairHistory(
  env: Env,
  a: string,
  b: string,
  now: number,
): Promise<{ recent: number[]; matchNumber: number }> {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const row = await env.DB.prepare('SELECT recent FROM pair_stats WHERE a_id = ? AND b_id = ?')
    .bind(lo, hi)
    .first<{ recent: string }>()
  let recent: number[] = []
  try {
    const parsed = JSON.parse(row?.recent ?? '[]') as unknown
    recent = Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number') : []
  } catch {
    recent = []
  }
  recent = recent.filter((t) => t > now - DAY_MS)
  return { recent, matchNumber: recent.length + 1 }
}
