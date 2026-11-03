import { describe, expect, it } from 'bun:test'
import { payout, scoreRun } from '../../../src/experiments/out-west/data/economy.ts'
import {
  baseBounty,
  bountyForLevel,
  canPrestige,
  duelPayout,
  duelPenalty,
  duelXp,
  effectiveLevel,
  FFA_XP,
  ffaBankXp,
  ffaDeathDrop,
  ffaDepositCommission,
  ffaKillMint,
  ffaStrongbox,
  GAUNTLET_REPEAT_XP,
  gauntletFirstClearCash,
  gauntletFirstClearXp,
  ghostRoyalty,
  LEVEL_THRESHOLDS,
  levelForXp,
  levelProgress,
  levelRewards,
  lossPenalty,
  MAX_LEVEL,
  pairFactor,
  speedBonus,
  streakBonus,
  titleFor,
  xpForLevel,
  xpToNext,
} from '../../../src/experiments/out-west/data/progression.ts'

describe('XP curve', () => {
  it('xpToNext = 150 + 80·(L − 1), 0 at the cap', () => {
    expect(xpToNext(1)).toBe(150)
    expect(xpToNext(2)).toBe(230)
    expect(xpToNext(49)).toBe(3990)
    expect(xpToNext(50)).toBe(0)
  })

  it('matches the spec table of cumulative XP', () => {
    expect(xpForLevel(1)).toBe(0)
    expect(xpForLevel(5)).toBe(1080)
    expect(xpForLevel(10)).toBe(4230)
    expect(xpForLevel(20)).toBe(16_530)
    expect(xpForLevel(30)).toBe(36_830)
    expect(xpForLevel(40)).toBe(65_130)
    expect(xpForLevel(50)).toBe(101_430)
  })

  it('levelForXp inverts it exactly at every threshold', () => {
    for (let l = 1; l <= MAX_LEVEL; l++) {
      expect(levelForXp(xpForLevel(l))).toBe(l)
      expect(levelForXp(xpForLevel(l) - 1)).toBe(Math.max(1, l - 1))
      expect(xpForLevel(l + 1) - xpForLevel(l)).toBe(l < MAX_LEVEL ? xpToNext(l) : 0)
    }
    expect(levelForXp(10_000_000)).toBe(50)
    expect(LEVEL_THRESHOLDS).toHaveLength(50)
    expect(levelProgress(1000)).toEqual({ level: 4, into: 310, next: 390 })
  })

  it('level rewards pay $25 × each new level', () => {
    expect(levelRewards(1, 2)).toBe(50)
    expect(levelRewards(4, 5)).toBe(125)
    expect(levelRewards(1, 5)).toBe(50 + 75 + 100 + 125)
    expect(levelRewards(5, 5)).toBe(0)
    expect(levelRewards(1, 50)).toBe(25 * (1275 - 1))
  })

  it('titles', () => {
    expect(titleFor(1)).toBe('Greenhorn')
    expect(titleFor(9)).toBe('Drifter')
    expect(titleFor(20)).toBe('Regulator')
    expect(titleFor(50)).toBe('Legend of the West')
  })

  it('prestige', () => {
    expect(canPrestige(50, 0)).toBe(true)
    expect(canPrestige(49, 0)).toBe(false)
    expect(canPrestige(50, 5)).toBe(false)
    expect(effectiveLevel(5, 2)).toBe(25)
    expect(effectiveLevel(45, 1)).toBe(50)
  })
})

describe('bounties', () => {
  it('base bounty matches the spec examples', () => {
    expect(baseBounty(1)).toBe(50)
    expect(baseBounty(10)).toBe(90)
    expect(baseBounty(20)).toBe(165)
    expect(baseBounty(30)).toBe(310)
    expect(baseBounty(40)).toBe(585)
    expect(baseBounty(50)).toBe(1095)
    expect(baseBounty(1, 5)).toBe(100)
  })

  it('the live bounty adds 10% per streak win, up to +50%', () => {
    expect(bountyForLevel(1)).toBe(50)
    expect(bountyForLevel(1, 2)).toBe(60)
    expect(bountyForLevel(1, 5)).toBe(75)
    expect(bountyForLevel(1, 50)).toBe(75)
    expect(bountyForLevel(50, 5)).toBe(1645)
  })

  it('every bounty is a multiple of $5 and grows with level', () => {
    for (let l = 1; l <= 50; l++) {
      expect(baseBounty(l) % 5).toBe(0)
      expect(baseBounty(l)).toBeGreaterThanOrEqual(baseBounty(Math.max(1, l - 1)))
    }
  })
})

describe('Bounty Hunt payouts and penalties', () => {
  it('speed bonus tiers', () => {
    expect(speedBonus(100, 170)).toBe(15)
    expect(speedBonus(100, 200)).toBe(8)
    expect(speedBonus(100, 250)).toBe(3)
    expect(speedBonus(100, 320)).toBe(0)
    expect(speedBonus(100, 90)).toBe(0)
    expect(speedBonus(100, null)).toBe(0)
  })

  it('duelPayout: loser bounty × (1 human | 0.5 ghost) + speed bonus, × pair factor', () => {
    expect(duelPayout({ loserBounty: 200, reactionMs: 250 })).toBe(206)
    expect(duelPayout({ loserBounty: 200, reactionMs: 170, ghost: true })).toBe(130)
    expect(duelPayout({ loserBounty: 200, reactionMs: 250, pairFactor: 0.5 })).toBe(103)
    expect(duelPayout({ loserBounty: 200, reactionMs: 250, pairFactor: 0 })).toBe(0)
  })

  it('loss penalty matches the spec examples', () => {
    expect(lossPenalty(250, bountyForLevel(1))).toBe(10)
    expect(lossPenalty(105, bountyForLevel(1))).toBe(5)
    expect(lossPenalty(100, bountyForLevel(1))).toBe(0)
    expect(lossPenalty(5000, bountyForLevel(15))).toBe(72)
    expect(lossPenalty(100_000, bountyForLevel(45))).toBe(480)
  })

  it('never takes the $100 reserve, whatever the multipliers', () => {
    for (let purse = 0; purse < 3000; purse += 7) {
      for (const bounty of [50, 300, 1645]) {
        const p = duelPenalty(purse, bounty)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(purse - p).toBeGreaterThanOrEqual(Math.min(purse, 100))
      }
    }
  })

  it('ghost and dodge losses cost half; pair factor scales', () => {
    expect(duelPenalty(5000, 120, { ghost: true })).toBe(36)
    expect(duelPenalty(5000, 120, { dodge: true })).toBe(36)
    expect(duelPenalty(5000, 120, { pairFactor: 0.25 })).toBe(18)
  })

  it('pair diminishing returns', () => {
    expect([1, 2, 3, 4, 5, 9].map(pairFactor)).toEqual([1, 1, 0.5, 0.25, 0, 0])
  })

  it('streak bonuses on the 3rd, 5th and 10th wins', () => {
    expect(streakBonus(2, 100)).toBe(0)
    expect(streakBonus(3, 100)).toBe(100)
    expect(streakBonus(5, 100)).toBe(200)
    expect(streakBonus(10, 100)).toBe(400)
    expect(streakBonus(11, 100)).toBe(0)
  })

  it('duel XP', () => {
    expect(duelXp({ result: 'win', reactionMs: 250 })).toBe(100)
    expect(duelXp({ result: 'win', reactionMs: 200 })).toBe(120)
    expect(duelXp({ result: 'win', reactionMs: 170 })).toBe(140)
    expect(duelXp({ result: 'loss', reactionMs: 170 })).toBe(80)
    expect(duelXp({ result: 'loss', reactionMs: null })).toBe(40)
    expect(duelXp({ result: 'dead_heat', reactionMs: 170 })).toBe(50)
    expect(duelXp({ result: 'froze', reactionMs: null })).toBe(25)
    expect(duelXp({ result: 'coward', reactionMs: 50 })).toBe(0)
    expect(duelXp({ result: 'dodge', reactionMs: null })).toBe(0)
    expect(duelXp({ result: 'win', reactionMs: 250, ghost: true })).toBe(60)
    expect(duelXp({ result: 'win', reactionMs: 250, pairFactor: 0 })).toBe(10)
    expect(duelXp({ result: 'win', reactionMs: 250, pairFactor: 0.5 })).toBe(50)
  })

  it('ghost royalties: $5 + 10% of the penalty, capped at $250 a day', () => {
    expect(ghostRoyalty(72, 0)).toBe(12)
    expect(ghostRoyalty(72, 245)).toBe(5)
    expect(ghostRoyalty(72, 250)).toBe(0)
  })
})

describe('gauntlet grants', () => {
  it('first clears: 40 + 15·i XP (2,720 total) and 10% of each poster', () => {
    const xp = Array.from({ length: 17 }, (_, i) => gauntletFirstClearXp(i))
    expect(xp.reduce((a, b) => a + b, 0)).toBe(2720)
    expect(gauntletFirstClearCash(0)).toBe(5)
    expect(gauntletFirstClearCash(16)).toBe(1000)
    const cash = Array.from({ length: 17 }, (_, i) => gauntletFirstClearCash(i))
    expect(cash.reduce((a, b) => a + b, 0)).toBe(2698)
    expect(GAUNTLET_REPEAT_XP).toBe(10)
  })

  it('leaves the existing gauntlet economy untouched', () => {
    expect(payout({ level: 0, outcome: 'win', reactionMs: 170 })).toBe(70)
    expect(scoreRun([{ level: 0, outcome: 'win', reactionMs: 250 }])).toBe(55)
  })
})

describe('Frontier FFA', () => {
  it('kill mint is 25% of the victim base bounty, +50% for Most Wanted', () => {
    expect(ffaKillMint(1)).toBe(12)
    expect(ffaKillMint(50)).toBe(273)
    expect(ffaKillMint(1, 0, true)).toBe(18)
  })

  it('death drops 70% (at least $10) and burns the rest; showdowns drop everything', () => {
    expect(ffaDeathDrop(1000)).toEqual({ drop: 700, burn: 300 })
    expect(ffaDeathDrop(12)).toEqual({ drop: 10, burn: 2 })
    expect(ffaDeathDrop(6)).toEqual({ drop: 6, burn: 0 })
    expect(ffaDeathDrop(0)).toEqual({ drop: 0, burn: 0 })
    expect(ffaDeathDrop(1000, true)).toEqual({ drop: 1000, burn: 0 })
  })

  it('commission: +10% at $500 or more, capped at $300', () => {
    expect(ffaDepositCommission(499)).toBe(0)
    expect(ffaDepositCommission(500)).toBe(50)
    expect(ffaDepositCommission(10_000)).toBe(300)
  })

  it('strongbox and banking XP', () => {
    expect(ffaStrongbox(32)).toBe(1040)
    expect(ffaBankXp(1234)).toBe(123)
    expect(FFA_XP.kill).toBe(30)
  })
})
