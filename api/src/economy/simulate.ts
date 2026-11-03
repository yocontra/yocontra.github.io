/**
 * Deterministic, seeded economy simulations behind the spec's inflation check (§5). Pure; used by
 * `simulate.test.ts` and handy for tuning (`bun api/src/economy/simulate.ts` prints a report).
 */
import {
  baseBounty,
  bountyForLevel,
  DAILY_FIRST_WIN_XP,
  dailyWinBonus,
  duelPayout,
  duelPenalty,
  duelXp,
  ffaDeathDrop,
  ffaDepositCommission,
  ffaKillMint,
  ffaStrongbox,
  levelForXp,
  levelRewards,
  MOST_WANTED_MIN_CARRY,
  START_PURSE,
  streakBonus,
} from '../../../src/experiments/out-west/data/progression.ts'

/** mulberry32: a tiny seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Box–Muller normal sample. */
const normal = (r: () => number, mean: number, sd: number): number =>
  mean + sd * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

export interface DuelSimOptions {
  seed: number
  duels: number
  winRate: number
  /** Mean judged reaction of the player, ms. */
  reactionMs?: number
  /** Duel cycles per hour; one "day" (and so one daily bonus) per hour of play. */
  perHour?: number
  /** Fixed opponent level instead of matching the player's own. */
  opponentLevel?: number
}

export interface DuelSimStep {
  duel: number
  level: number
  purse: number
  xp: number
  gross: number
  penalties: number
}

export interface DuelSimResult {
  steps: DuelSimStep[]
  /** First duel index (1-based) at which each level was reached. */
  reachedAt: Map<number, number>
  gross: number
  penalties: number
  maxSinglePayout: number
  minPurse: number
}

/** One Bounty Hunt player over `duels` duels against same-level human opponents. */
export function simulateDuels(o: DuelSimOptions): DuelSimResult {
  const r = rng(o.seed)
  const perHour = o.perHour ?? 80
  let purse = START_PURSE
  let xp = 0
  let level = 1
  let streak = 0
  let gross = 0
  let penalties = 0
  let maxSinglePayout = 0
  let minPurse = purse
  let wonToday = false
  const reachedAt = new Map<number, number>([[1, 0]])
  const steps: DuelSimStep[] = []
  for (let duel = 1; duel <= o.duels; duel++) {
    if (duel % perHour === 1) {
      wonToday = false
    }
    const oppLevel =
      o.opponentLevel ?? Math.max(1, Math.min(50, level + Math.round(normal(r, 0, 1.5))))
    // Opponents arrive with a small streak of their own (geometric, mean ≈ 1).
    let oppStreak = 0
    while (r() < 0.5 && oppStreak < 5) {
      oppStreak++
    }
    const reaction = Math.max(140, normal(r, o.reactionMs ?? 235, 30))
    let gainedXp: number
    if (r() < o.winRate) {
      streak++
      const own = baseBounty(level)
      let pay = duelPayout({
        loserBounty: bountyForLevel(oppLevel, oppStreak),
        reactionMs: reaction,
      })
      maxSinglePayout = Math.max(maxSinglePayout, pay)
      pay += streakBonus(streak, own)
      gainedXp = duelXp({ result: 'win', reactionMs: reaction })
      if (!wonToday) {
        wonToday = true
        pay += dailyWinBonus(own)
        gainedXp += DAILY_FIRST_WIN_XP
      }
      purse += pay
      gross += pay
    } else {
      const penalty = duelPenalty(purse, bountyForLevel(level, streak))
      streak = 0
      purse -= penalty
      penalties += penalty
      gainedXp = duelXp({ result: 'loss', reactionMs: reaction + 25 })
    }
    xp += gainedXp
    const next = levelForXp(xp)
    if (next > level) {
      const reward = levelRewards(level, next)
      purse += reward
      gross += reward
      for (let l = level + 1; l <= next; l++) {
        reachedAt.set(l, duel)
      }
      level = next
    }
    minPurse = Math.min(minPurse, purse)
    steps.push({ duel, level, purse, xp, gross, penalties })
  }
  return { steps, reachedAt, gross, penalties, maxSinglePayout, minPurse }
}

export interface FfaSimResult {
  players: number
  minted: number
  boxes: number
  commission: number
  banked: number
  burned: number
  expired: number
  carriedAtEnd: number
  /** Median banked dollars per player-hour. */
  medianPerHour: number
  topPerHour: number
}

/**
 * One full Frontier lobby for `hours`, one-second steps. About 3,200 kills per lobby-hour (one
 * kill per player every ~36 s), a strongbox every 3 min, players bank at a personal threshold,
 * and the killer usually wins the bag (vultures and expiry take the rest).
 */
interface FfaLobby {
  r: () => number
  players: number
  levels: number[]
  skill: number[]
  bankAt: number[]
  carried: number[]
  bankedBy: number[]
  t: {
    minted: number
    boxes: number
    commission: number
    banked: number
    burned: number
    expired: number
  }
}

function pickWeighted(r: () => number, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0)
  let x = r() * total
  for (const [i, w] of weights.entries()) {
    x -= w
    if (x <= 0) {
      return i
    }
  }
  return weights.length - 1
}

const add = (arr: number[], i: number, n: number): void => {
  arr[i] = (arr[i] ?? 0) + n
}

/** One kill: mint to the killer, the victim's carry drops (mostly to the killer) or burns. */
function ffaKill(l: FfaLobby): void {
  const killer = pickWeighted(l.r, l.skill)
  let victim = pickWeighted(
    l.r,
    l.skill.map((w) => 1 / w),
  )
  if (victim === killer) {
    victim = (victim + 1) % l.players
  }
  const richest = l.carried.indexOf(Math.max(...l.carried))
  const mostWanted = victim === richest && (l.carried[victim] ?? 0) >= MOST_WANTED_MIN_CARRY
  const mint = ffaKillMint(l.levels[victim] ?? 1, 0, mostWanted)
  add(l.carried, killer, mint)
  l.t.minted += mint
  const { drop, burn } = ffaDeathDrop(l.carried[victim] ?? 0)
  l.carried[victim] = 0
  l.t.burned += burn
  const roll = l.r()
  if (roll < 0.75) {
    add(l.carried, killer, drop)
  } else if (roll < 0.93) {
    add(l.carried, Math.floor(l.r() * l.players), drop)
  } else {
    l.t.expired += drop
  }
}

/** Anyone at their banking threshold reaches a window within ~20 s on average. */
function ffaBank(l: FfaLobby): void {
  for (let p = 0; p < l.players; p++) {
    const carry = l.carried[p] ?? 0
    if (carry >= (l.bankAt[p] ?? 500) && l.r() < 0.05) {
      const commission = ffaDepositCommission(carry)
      l.t.commission += commission
      l.t.banked += carry + commission
      add(l.bankedBy, p, carry + commission)
      l.carried[p] = 0
    }
  }
}

export function simulateFfa(seed: number, hours = 1, players = 32): FfaSimResult {
  const r = rng(seed)
  const l: FfaLobby = {
    r,
    players,
    levels: Array.from({ length: players }, () => 15 + Math.floor(r() * 21)),
    skill: Array.from({ length: players }, () => 0.5 + r()),
    bankAt: Array.from({ length: players }, () => 250 + Math.floor(r() * 1000)),
    carried: new Array<number>(players).fill(0),
    bankedBy: new Array<number>(players).fill(0),
    t: { minted: 0, boxes: 0, commission: 0, banked: 0, burned: 0, expired: 0 },
  }
  const killsPerSecond = (players * 100) / 3600
  for (let s = 0; s < hours * 3600; s++) {
    const kills = Math.floor(killsPerSecond) + (r() < killsPerSecond % 1 ? 1 : 0)
    for (let k = 0; k < kills; k++) {
      ffaKill(l)
    }
    if (s % 180 === 179) {
      const value = ffaStrongbox(players)
      add(l.carried, pickWeighted(r, l.skill), value)
      l.t.boxes += value
    }
    ffaBank(l)
  }
  const perHour = l.bankedBy.map((b) => b / hours).sort((a, b) => a - b)
  return {
    players,
    ...l.t,
    carriedAtEnd: l.carried.reduce((a, b) => a + b, 0),
    medianPerHour: perHour[Math.floor(players / 2)] ?? 0,
    topPerHour: perHour.at(-1) ?? 0,
  }
}

if (import.meta.main) {
  const median = simulateDuels({ seed: 1, duels: 3000, winRate: 0.5 })
  console.warn('levels reached at duel:', Object.fromEntries(median.reachedAt))
  console.warn('penalty share of gross:', (median.penalties / median.gross).toFixed(3))
  console.warn('ffa:', simulateFfa(7))
}
