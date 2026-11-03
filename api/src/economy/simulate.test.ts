/**
 * The spec's inflation check (§4, §5), reproduced as deterministic seeded simulations. Bands are
 * wide enough to hold across seeds but tight enough to catch a formula that drifts.
 */
import { describe, expect, it } from 'bun:test'
import { CATALOG } from '../../../src/experiments/out-west/data/catalog.ts'
import { MAX_DUEL_PAYOUT, START_PURSE } from '../../../src/experiments/out-west/data/progression.ts'
import { simulateDuels, simulateFfa } from './simulate.ts'

const SEEDS = [1, 2, 3, 4, 5]
const CATALOG_TOTAL = CATALOG.reduce((sum, item) => sum + item.price, 0)

describe('Bounty Hunt: 3,000 duels at a 50% win rate', () => {
  const runs = SEEDS.map((seed) => simulateDuels({ seed, duels: 3000, winRate: 0.5 }))

  it('levels on the spec curve (L10 ≈ 55, L20 ≈ 225, L30 ≈ 480, L40 ≈ 830, L50 ≈ 1,300 duels)', () => {
    const bands: [number, number, number][] = [
      [5, 8, 25],
      [10, 40, 70],
      [20, 190, 260],
      [30, 430, 540],
      [40, 770, 920],
      [50, 1200, 1450],
    ]
    for (const run of runs) {
      for (const [level, lo, hi] of bands) {
        const at = run.reachedAt.get(level) ?? Number.POSITIVE_INFINITY
        expect(at).toBeGreaterThanOrEqual(lo)
        expect(at).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('loss penalties sink about 45% of gross', () => {
    for (const run of runs) {
      const share = run.penalties / run.gross
      expect(share).toBeGreaterThan(0.38)
      expect(share).toBeLessThan(0.55)
    }
  })

  it('nets roughly $20–40k from L21 to L30 (spec: $23.5k over 250 duels)', () => {
    for (const run of runs) {
      const from = run.reachedAt.get(21) ?? 0
      const to = run.reachedAt.get(30) ?? 0
      const net = (run.steps[to - 1]?.purse ?? 0) - (run.steps[from - 1]?.purse ?? 0)
      expect(to - from).toBeGreaterThan(180)
      expect(to - from).toBeLessThan(320)
      expect(net).toBeGreaterThan(15_000)
      expect(net).toBeLessThan(45_000)
    }
  })

  it('a median player can afford the whole catalog after roughly 1,200–2,200 duels', () => {
    expect(CATALOG_TOTAL).toBe(306_950)
    for (const run of runs) {
      const at = run.steps.find((s) => s.purse >= CATALOG_TOTAL)?.duel ?? Number.POSITIVE_INFINITY
      expect(at).toBeGreaterThan(1200)
      expect(at).toBeLessThan(2200)
    }
  })

  it('never wipes anyone: the purse never drops below the start or the $100 reserve', () => {
    for (const run of runs) {
      expect(run.minPurse).toBeGreaterThanOrEqual(Math.min(START_PURSE, 100))
    }
  })

  it('no single payout exceeds the hard bound (≈ $1,900)', () => {
    expect(MAX_DUEL_PAYOUT).toBe(1892)
    for (const run of runs) {
      expect(run.maxSinglePayout).toBeLessThanOrEqual(MAX_DUEL_PAYOUT)
    }
  })
})

describe('Bounty Hunt: other skill levels', () => {
  it('nobody stagnates: a 40% player still nets money (spec: ~$48k after 1,000 duels)', () => {
    for (const seed of SEEDS) {
      const run = simulateDuels({ seed, duels: 1000, winRate: 0.4 })
      const final = run.steps.at(-1)?.purse ?? 0
      expect(final).toBeGreaterThan(30_000)
      expect(final).toBeLessThan(110_000)
    }
  })

  it('a top player at the cap earns well under the hard bound per hour (spec: ~$100k/h)', () => {
    for (const seed of SEEDS) {
      const run = simulateDuels({ seed, duels: 3000, winRate: 0.7, reactionMs: 200 })
      const lastHour = (run.steps[2999]?.purse ?? 0) - (run.steps[2919]?.purse ?? 0)
      expect(run.steps.at(-1)?.level).toBe(50)
      expect(lastHour).toBeGreaterThan(40_000)
      expect(lastHour).toBeLessThan(80 * MAX_DUEL_PAYOUT)
    }
  })

  it('is deterministic for a seed', () => {
    const a = simulateDuels({ seed: 42, duels: 500, winRate: 0.5 })
    const b = simulateDuels({ seed: 42, duels: 500, winRate: 0.5 })
    expect(a.steps.at(-1)).toEqual(b.steps.at(-1))
  })
})

describe('Frontier FFA: one full lobby-hour', () => {
  const runs = SEEDS.map((seed) => simulateFfa(seed))

  it('conserves money: everything printed is banked, burned, expired or still carried', () => {
    for (const r of runs) {
      const printed = r.minted + r.boxes + r.commission
      expect(r.banked + r.burned + r.expired + r.carriedAtEnd).toBe(printed)
    }
  })

  it('prints only from kills, strongboxes and commission, under the lobby-hour bound', () => {
    for (const r of runs) {
      expect(r.boxes).toBe(20 * (400 + 20 * 32))
      expect(r.minted + r.boxes + r.commission).toBeLessThan(260_000)
    }
  })

  it('burns roughly 35–60% of what it prints (death burn plus expired bags)', () => {
    for (const r of runs) {
      const sunk = (r.burned + r.expired) / (r.minted + r.boxes + r.commission)
      expect(sunk).toBeGreaterThan(0.35)
      expect(sunk).toBeLessThan(0.65)
    }
  })

  it('earns less per hour than Bounty Hunt for the median player', () => {
    const bh = simulateDuels({ seed: 1, duels: 3000, winRate: 0.5 })
    const from = bh.reachedAt.get(21) ?? 0
    const to = bh.reachedAt.get(30) ?? 0
    const bhPerHour =
      (((bh.steps[to - 1]?.purse ?? 0) - (bh.steps[from - 1]?.purse ?? 0)) / (to - from)) * 80
    for (const r of runs) {
      expect(r.medianPerHour).toBeGreaterThan(500)
      expect(r.medianPerHour).toBeLessThan(bhPerHour)
      expect(r.topPerHour).toBeLessThan(25_000)
    }
  })
})
