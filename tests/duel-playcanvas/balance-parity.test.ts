import { expect, test as it } from 'bun:test'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import baseline from './balance-baseline.json' with { type: 'json' }
import { lastWinningMs, type SimOptions, standoff } from './duel-sim.ts'

type Row = [number, number, string, number, number | null, number | null, string | null, number]

const VARIANTS: Readonly<Record<string, Partial<SimOptions>>> = {
  key: {},
  touchAssist: { touch: true, assist: true, phase0: 5 },
  legend: { legend: true, phase0: 11 },
  fps30: { frameMs: 1000 / 30, phase0: 7 },
}

const rows = baseline.rows as Row[]

it('covers every outlaw and both boss phases', () => {
  const covered = new Set(rows.map(([level, phase]) => `${level}:${phase}`))
  expect(covered.size).toBe(OUTLAWS.length + 1)
})

for (const [level, bossPhase, variant, random, threshold, ms, grade, purse] of rows) {
  const name = `${OUTLAWS[level]?.name} phase ${bossPhase}, ${variant}, random ${random}`
  it(`matches the original engine: ${name}`, () => {
    const options = {
      level,
      random,
      bossPhase: bossPhase as 1 | 2,
      // the PlayCanvas systems run before the duel's update; timing must not depend on them
      updateLag: 3,
      ...VARIANTS[variant],
      ...(OUTLAWS[level]?.gimmick === 'underboss' ? { second: 120 } : {}),
    }
    expect(lastWinningMs(options)).toBe(threshold)
    const result = standoff({ ...options, reaction: threshold ?? 0 })
    expect(result.ms === null ? null : Math.round(result.ms * 1000) / 1000).toBe(ms)
    expect(result.grade).toBe(grade)
    expect(result.purse).toBe(purse)
  })
}
