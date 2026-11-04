/**
 * Per-outlaw medals and challenges for the single-player gauntlet. Pure data and rules, shared by
 * the client (the gauntlet map, the guest purse) and the Worker (account grants from server-judged
 * ranked wins). Owned by the meta-game stream.
 *
 * - A **medal** is earned by a winning first shot faster than the outlaw's threshold. Tiers are
 *   cumulative: a gold also earns the silver and the bronze. Second-chance wins and Legend runs
 *   don't count.
 * - A **challenge** is one gimmick task per outlaw. Most are judged from what the ranked server
 *   sees (the win, the reaction, the fake-outs that fired, the attempt count, a clean run).
 *   Hat shots are aimed on the client, so they are `claim` challenges: XP only, and only against a
 *   ranked win of that outlaw the server recorded a moment ago.
 *
 * Every id here is stable: it keys the database, the save file and the achievements.
 * Bump MEDALS_VERSION whenever a threshold or a payout changes.
 */
import { BOUNTIES } from './economy.ts'

export const MEDALS_VERSION = 1

export const TIERS = ['bronze', 'silver', 'gold'] as const
export type Tier = (typeof TIERS)[number]

/** 0 = none, 1 = bronze, 2 = silver, 3 = gold. */
export type TierRank = 0 | 1 | 2 | 3

/**
 * Bronze, silver and gold thresholds per outlaw, ms (a win's first shot must be faster).
 * Bronze always sits under the outlaw's draw time, so a medal is never just "you won".
 * Tuned to the retuned curve: 900/750 for the tutorial pair, then 520 → 300 ms.
 */
export const MEDAL_MS: readonly (readonly [number, number, number])[] = [
  [420, 320, 240], // 1 Bret P. Barsh
  [400, 310, 235], // 2 Prescott J. House
  [380, 300, 230], // 3 Calhoun C. Trine
  [370, 295, 228], // 4 Ace Q. McConly
  [360, 290, 225], // 5 Burney N. Coover
  [350, 285, 222], // 6 Salvador R. Gruell
  [340, 280, 220], // 7 Felipe K. Wheeler
  [330, 275, 218], // 8 Laura Bullion
  [320, 270, 215], // 9 Thomas B. Arnold
  [315, 265, 212], // 10 Delmer F. Gusselman
  [310, 260, 210], // 11 Pearl Hart
  [305, 255, 208], // 12 Luke Short
  [300, 250, 205], // 13 Dallas Stoudenmire
  [295, 245, 202], // 14 Kid Curry
  [290, 240, 200], // 15 Wild Bill Hickok
  [320, 260, 210], // 16 Curly Bill and the rifleman
  [300, 245, 200], // 17 John Wesley Hardin (the final kill)
]

export const OUTLAW_COUNT = MEDAL_MS.length

/** One-time pay per tier, per outlaw, per account. */
export const MEDAL_PAY: Readonly<Record<Tier, { xp: number; cash: number }>> = {
  bronze: { xp: 25, cash: 15 },
  silver: { xp: 40, cash: 30 },
  gold: { xp: 60, cash: 60 },
}

/** One-time pay for a server-judged challenge. */
export const CHALLENGE_PAY = { xp: 50, cash: 40 } as const
/** One-time pay for a claimed (client-aimed) challenge: XP only. */
export const CLAIM_PAY = { xp: 50, cash: 0 } as const
/** A claim must follow its server-recorded ranked win within this long. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000

/** The medal tier a winning first shot earns on outlaw `level` (0 when none). */
export function tierFor(level: number, reactionMs: number | null): TierRank {
  const t = MEDAL_MS[level]
  if (!t || reactionMs === null || !Number.isFinite(reactionMs) || reactionMs <= 0) {
    return 0
  }
  if (reactionMs < t[2]) {
    return 3
  }
  if (reactionMs < t[1]) {
    return 2
  }
  return reactionMs < t[0] ? 1 : 0
}

export const tierName = (rank: TierRank): Tier | null =>
  rank === 0 ? null : (TIERS[rank - 1] ?? null)

/** XP and dollars for going from tier `from` to tier `to` on one outlaw (each tier pays once). */
export function medalPay(from: TierRank, to: TierRank): { xp: number; cash: number } {
  let xp = 0
  let cash = 0
  for (let r = from + 1; r <= to; r++) {
    const pay = MEDAL_PAY[TIERS[r - 1] as Tier]
    xp += pay.xp
    cash += pay.cash
  }
  return { xp, cash }
}

// ─── Challenges ────────────────────────────────────────────────────────────────────────────────

/** What a judged win shows about itself. The ranked server can vouch for all of it but `hatShot`. */
export interface ChallengeEvidence {
  reactionMs: number | null
  fakesSeen: number
  /** No earlier attempt on this outlaw in this run. */
  firstTry: boolean
  /** No early draw on this outlaw in this run. */
  clean: boolean
  hatShot: boolean
}

type Rule =
  | { kind: 'firstTry' }
  | { kind: 'fakes'; min: number }
  | { kind: 'fakesFirstTry'; min: number }
  | { kind: 'under'; ms: number }
  | { kind: 'hat' }
  | { kind: 'clean' }

export interface Challenge {
  /** Stable id, `ch.<outlaw 1-based>.<slug>`. */
  readonly id: string
  readonly level: number
  readonly title: string
  /** One line for the map: what to do. */
  readonly task: string
  readonly rule: Rule
}

const ch = (
  level: number,
  slug: string,
  [title, task]: readonly [string, string],
  rule: Rule,
): Challenge => ({
  id: `ch.${level + 1}.${slug}`,
  level,
  title,
  task,
  rule,
})

/** One per outlaw, in roster order. */
export const CHALLENGES: readonly Challenge[] = [
  ch(0, 'steady', ['Steady Hand', 'Beat him on your first try.'], { kind: 'firstTry' }),
  ch(1, 'hat', ['Talk Through Your Hat', 'Shoot his hat off.'], { kind: 'hat' }),
  ch(2, 'crow', ['Let the Crow Fly', 'Win after a fake-out, without flinching.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(3, 'coin', ['Heads or Tails', 'Don’t flinch at the coin. Win after it lands.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(4, 'hat', ['Hair of the Dog', 'Shoot his hat off.'], { kind: 'hat' }),
  ch(5, 'patience', ['Outwait Him', 'Beat him on your first try.'], { kind: 'firstTry' }),
  ch(6, 'wind', ['Steady in the Wind', 'Win through a fake-out on your first try.'], {
    kind: 'fakesFirstTry',
    min: 1,
  }),
  ch(7, 'cold', ['Colder Than Laura', 'Win under 250 ms.'], { kind: 'under', ms: 250 }),
  ch(8, 'whistle', ['False Alarm', 'Win after a fake-out, without flinching.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(9, 'hat', ['Hats Off', 'Shoot his hat off, not his hands.'], { kind: 'hat' }),
  ch(10, 'deaf', ['Deaf to It', 'Win after one of her heckles.'], { kind: 'fakes', min: 1 }),
  ch(11, 'piano', ['Play It Again', 'Win through the piano on your first try.'], {
    kind: 'fakesFirstTry',
    min: 1,
  }),
  ch(12, 'dark', ['In the Dark', 'Beat him on your first try.'], { kind: 'firstTry' }),
  ch(13, 'king', ['Not Fooled', 'Win through his twitch on your first try.'], {
    kind: 'fakesFirstTry',
    min: 1,
  }),
  ch(14, 'hand', ['Dead Man’s Hand', 'Win under 230 ms.'], { kind: 'under', ms: 230 }),
  ch(15, 'gunshot', ['Gunshot, No Flinch', 'Win after a fake-out, without flinching.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(16, 'midnight', ['No Flinch at Midnight', 'Kill Hardin without drawing early on him.'], {
    kind: 'clean',
  }),
]

/** Challenges the server can't judge: the client claims them after a recorded ranked win. */
export const isClaim = (c: Challenge): boolean => c.rule.kind === 'hat'

export function challengeFor(level: number): Challenge | undefined {
  return CHALLENGES[level]
}

export function challengeById(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id)
}

/** Whether a won duel meets the challenge. */
export function meets(c: Challenge, e: ChallengeEvidence): boolean {
  const r = c.rule
  switch (r.kind) {
    case 'firstTry':
      return e.firstTry
    case 'fakes':
      return e.fakesSeen >= r.min
    case 'fakesFirstTry':
      return e.fakesSeen >= r.min && e.firstTry
    case 'under':
      return e.reactionMs !== null && e.reactionMs > 0 && e.reactionMs < r.ms
    case 'hat':
      return e.hatShot
    case 'clean':
      return e.clean
    default:
      return false
  }
}

// ─── Progress records ──────────────────────────────────────────────────────────────────────────

/** One outlaw's medal and challenge, as the map shows it. */
export interface OutlawMark {
  /** Best tier earned. */
  tier: TierRank
  /** Best winning first shot, ms (null if never won with a counted shot). */
  bestMs: number | null
  challenge: boolean
}

export const emptyMark = (): OutlawMark => ({ tier: 0, bestMs: null, challenge: false })

/** The better of two marks (device and account). */
export function mergeMark(a: OutlawMark | undefined, b: OutlawMark | undefined): OutlawMark {
  const x = a ?? emptyMark()
  const y = b ?? emptyMark()
  const best = [x.bestMs, y.bestMs].filter((m): m is number => m !== null)
  return {
    tier: Math.max(x.tier, y.tier) as TierRank,
    bestMs: best.length > 0 ? Math.min(...best) : null,
    challenge: x.challenge || y.challenge,
  }
}

/** Totals for sets: how many outlaws hold at least each tier, and challenges done. */
export function tally(marks: readonly (OutlawMark | undefined)[]): {
  bronze: number
  silver: number
  gold: number
  tiers: number
  challenges: number
} {
  let bronze = 0
  let silver = 0
  let gold = 0
  let challenges = 0
  for (let i = 0; i < OUTLAW_COUNT; i++) {
    const m = marks[i]
    if (!m) {
      continue
    }
    bronze += Number(m.tier >= 1)
    silver += Number(m.tier >= 2)
    gold += Number(m.tier >= 3)
    challenges += Number(m.challenge)
  }
  return { bronze, silver, gold, tiers: bronze + silver + gold, challenges }
}

/** Total one-time XP and dollars the medals and challenges can pay (for copy and tests). */
export function maxSoloPay(): { xp: number; cash: number } {
  const per = medalPay(0, 3)
  let xp = per.xp * OUTLAW_COUNT
  let cash = per.cash * OUTLAW_COUNT
  for (const c of CHALLENGES) {
    const pay = isClaim(c) ? CLAIM_PAY : CHALLENGE_PAY
    xp += pay.xp
    cash += pay.cash
  }
  return { xp, cash }
}

if (MEDAL_MS.length !== BOUNTIES.length || CHALLENGES.length !== BOUNTIES.length) {
  throw new Error('medals: one row per outlaw')
}
