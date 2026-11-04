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
import { gauntletFirstClearCash, gauntletFirstClearXp } from './progression.ts'

export const MEDALS_VERSION = 1

export const TIERS = ['bronze', 'silver', 'gold'] as const
export type Tier = (typeof TIERS)[number]

/** 0 = none, 1 = bronze, 2 = silver, 3 = gold. */
export type TierRank = 0 | 1 | 2 | 3

/**
 * Bronze, silver and gold thresholds per outlaw, ms (a win's first shot must be faster).
 * Bronze always sits under the outlaw's draw time, so a medal is never just "you won".
 * Tuned to duel-core's curve (by gauntlet slot): 900/750 for the tutorial pair, then 520 → 300 ms.
 */
export const MEDAL_MS: readonly (readonly [number, number, number])[] = [
  [420, 320, 240], // 1 Bret P. Barsh (draws 900)
  [400, 310, 235], // 2 Prescott J. House (750)
  [390, 300, 230], // 3 Calhoun C. Trine (520)
  [380, 295, 228], // 4 Burney N. Coover (502 ± 140)
  [370, 290, 225], // 5 Ace Q. McConly (483)
  [360, 285, 222], // 6 Delmer F. Gusselman (345, first shot always misses: 465)
  [350, 280, 220], // 7 Salvador R. Gruell (447)
  [340, 275, 218], // 8 Felipe K. Wheeler (428)
  [330, 270, 215], // 9 Laura Bullion (410)
  [320, 265, 212], // 10 Thomas B. Arnold (392)
  [310, 260, 210], // 11 Pearl Hart (373)
  [305, 255, 208], // 12 Luke Short (355)
  [300, 250, 205], // 13 Dallas Stoudenmire (337)
  [295, 245, 202], // 14 Kid Curry (318)
  [285, 240, 200], // 15 Wild Bill Hickok (300)
  [320, 260, 210], // 16 Curly Bill and the rifleman (rifleman 330)
  [270, 235, 200], // 17 John Wesley Hardin, the phase-two kill (280)
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

/** One per outlaw, by gauntlet slot (OUTLAWS order). */
export const CHALLENGES: readonly Challenge[] = [
  ch(0, 'steady', ['Steady Hand', 'Beat him on your first try.'], { kind: 'firstTry' }),
  ch(1, 'hat', ['Talk Through Your Hat', 'Shoot his hat off.'], { kind: 'hat' }),
  ch(2, 'crow', ['Let the Crow Fly', 'Win after a fake-out without drawing early.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(3, 'hat', ['Hair of the Dog', 'Shoot his hat off.'], { kind: 'hat' }),
  ch(4, 'coin', ['Heads or Tails', 'Don’t draw at the coin. Win after it lands.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(5, 'hat', ['Hats Off', 'Shoot his hat off, not his hands.'], { kind: 'hat' }),
  ch(6, 'patience', ['Outwait Him', 'Beat him on your first try.'], { kind: 'firstTry' }),
  ch(7, 'wind', ['Steady in the Wind', 'Ignore the fake-out. Win on your first try.'], {
    kind: 'fakesFirstTry',
    min: 1,
  }),
  ch(8, 'cold', ['Colder Than Laura', 'Win under 250 ms.'], { kind: 'under', ms: 250 }),
  ch(9, 'whistle', ['False Alarm', 'Win after a fake-out without drawing early.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(10, 'deaf', ['Deaf to It', 'Win after one of her heckles.'], { kind: 'fakes', min: 1 }),
  ch(11, 'piano', ['Play It Again', 'Ignore the piano. Win on your first try.'], {
    kind: 'fakesFirstTry',
    min: 1,
  }),
  ch(12, 'dark', ['In the Dark', 'Beat him on your first try.'], { kind: 'firstTry' }),
  ch(13, 'king', ['Not Fooled', 'Ignore his twitch. Win on your first try.'], {
    kind: 'fakesFirstTry',
    min: 1,
  }),
  ch(14, 'hand', ['Dead Man’s Hand', 'Win under 230 ms.'], { kind: 'under', ms: 230 }),
  ch(15, 'gunshot', ['Gunshot, No Flinch', 'Win after a fake-out without drawing early.'], {
    kind: 'fakes',
    min: 1,
  }),
  ch(16, 'midnight', ['No Flinch at Midnight', 'Beat Hardin without drawing early.'], {
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

// ─── Gauntlet-earned cosmetics ─────────────────────────────────────────────────────────────────

export type RewardRule =
  | { kind: 'tierSet'; tier: TierRank }
  | { kind: 'challenges' }
  | { kind: 'hats' }
  | { kind: 'tiers'; count: number }
  | { kind: 'challenge'; id: string }
  | { kind: 'daily'; wins: number }
  | { kind: 'legend'; beaten: number }

/**
 * The ten gauntlet-earned cosmetics (catalog `reward` items) and what earns each. All but the
 * Legend pair are granted by the server from its own records; the Legend pair is claimed from the
 * device (Legend runs aren't server-judged) and only by an account that has cleared the full
 * gauntlet on ranked runs.
 */
export const SOLO_REWARDS: readonly { readonly item: string; readonly rule: RewardRule }[] = [
  { item: 'hat.bronze-band', rule: { kind: 'tierSet', tier: 1 } },
  { item: 'holster.silver-conchos', rule: { kind: 'tierSet', tier: 2 } },
  { item: 'gun.gold-medal', rule: { kind: 'tierSet', tier: 3 } },
  { item: 'bag.medal-satchel', rule: { kind: 'tiers', count: 25 } },
  { item: 'frame.tall-tales', rule: { kind: 'challenges' } },
  { item: 'hat.holed-stetson', rule: { kind: 'hats' } },
  { item: 'outfit.midnight-coat', rule: { kind: 'challenge', id: 'ch.17.midnight' } },
  { item: 'extra.black-bandana', rule: { kind: 'daily', wins: 7 } },
  { item: 'spurs.legend-rowels', rule: { kind: 'legend', beaten: 6 } },
  { item: 'frame.legend', rule: { kind: 'legend', beaten: 9 } },
]

export interface RewardState {
  marks: readonly (OutlawMark | undefined)[]
  /** Days with a Daily Outlaw win. */
  dailyWins: number
  /** Most outlaws beaten in one Legend run. */
  legendBest: number
}

export function meetsReward(rule: RewardRule, s: RewardState): boolean {
  const t = tally(s.marks)
  switch (rule.kind) {
    case 'tierSet':
      return [0, t.bronze, t.silver, t.gold][rule.tier] === OUTLAW_COUNT
    case 'challenges':
      return t.challenges === OUTLAW_COUNT
    case 'hats':
      return CHALLENGES.filter(isClaim).every((c) => s.marks[c.level]?.challenge === true)
    case 'tiers':
      return t.tiers >= rule.count
    case 'challenge': {
      const c = challengeById(rule.id)
      return c !== undefined && s.marks[c.level]?.challenge === true
    }
    case 'daily':
      return s.dailyWins >= rule.wins
    case 'legend':
      return s.legendBest >= rule.beaten
    default:
      return false
  }
}

/** Reward items `s` has earned (catalog ids). */
export function earnedRewards(s: RewardState): string[] {
  return SOLO_REWARDS.filter((r) => meetsReward(r.rule, s)).map((r) => r.item)
}

// ─── The guest purse, and its migration into an account ────────────────────────────────────────

/** A guest's purse and XP ride into a new account up to this much, once per account. */
export const GUEST_CAP = { xp: 2000, cash: 750 } as const

/** What a device says it earned as a guest. The server sanitises and re-prices it. */
export interface GuestClaim {
  /** Per outlaw: best tier and whether the challenge is done. */
  marks: readonly { tier: number; challenge: boolean }[]
  /** 17-bit mask of outlaws beaten. */
  clears: number
}

/**
 * The guest purse: first clears, medals and challenges, priced with the account's own one-time
 * rules. `raw` is the uncapped sum (the guest's own purse on the device), `xp`/`cash` what migrates.
 */
export function guestCredit(claim: GuestClaim): {
  xp: number
  cash: number
  raw: { xp: number; cash: number }
} {
  let xp = 0
  let cash = 0
  const clears = Number.isInteger(claim.clears) ? claim.clears : 0
  for (let i = 0; i < OUTLAW_COUNT; i++) {
    if ((clears & (1 << i)) !== 0) {
      xp += gauntletFirstClearXp(i)
      cash += gauntletFirstClearCash(i)
    }
    const m = claim.marks[i]
    if (!m) {
      continue
    }
    const tier = Math.min(3, Math.max(0, Math.floor(Number(m.tier) || 0))) as TierRank
    const pay = medalPay(0, tier)
    xp += pay.xp
    cash += pay.cash
    const c = CHALLENGES[i]
    if (m.challenge === true && c) {
      const cp = isClaim(c) ? CLAIM_PAY : CHALLENGE_PAY
      xp += cp.xp
      cash += cp.cash
    }
  }
  return {
    xp: Math.min(GUEST_CAP.xp, xp),
    cash: Math.min(GUEST_CAP.cash, cash),
    raw: { xp, cash },
  }
}

if (MEDAL_MS.length !== BOUNTIES.length || CHALLENGES.length !== BOUNTIES.length) {
  throw new Error('medals: one row per outlaw')
}
