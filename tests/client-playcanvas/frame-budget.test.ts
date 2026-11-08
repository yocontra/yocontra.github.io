import { describe, expect, test as it } from 'bun:test'
import { FrameBudget } from '../../src/experiments/out-west/client/frame-budget.ts'

describe('mobile rendering budget', () => {
  it('records long active-game stalls rather than removing them from minimum FPS', () => {
    const budget = new FrameBudget(1)
    for (let i = 0; i < 60; i++) {
      budget.sample(1 / 60)
    }
    budget.sample(0.5)
    expect(budget.worstFps).toBeLessThan(35)
    expect(budget.worstFps).toBeGreaterThan(0)
  })
  it('reduces resolution under sustained load but preserves the CSS-pixel floor', () => {
    const budget = new FrameBudget(1.5)
    for (let i = 0; i < 600; i++) {
      budget.sample(1 / 25)
    }
    expect(budget.pixelRatio).toBe(1)
    expect(budget.worstFps).toBeCloseTo(25, 1)
  })
  it('recovers resolution only with sustained frame headroom', () => {
    const budget = new FrameBudget(1.5)
    for (let i = 0; i < 120; i++) {
      budget.sample(1 / 25)
    }
    const degraded = budget.pixelRatio
    for (let i = 0; i < 300; i++) {
      budget.sample(1 / 60)
    }
    expect(budget.pixelRatio).toBe(degraded)
    for (let i = 0; i < 900; i++) {
      budget.sample(1 / 60)
    }
    expect(budget.pixelRatio).toBeGreaterThan(degraded)
    expect(budget.pixelRatio).toBeLessThanOrEqual(1.5)
  })
  it('background reset discards the old window without erasing recorded minimum', () => {
    const budget = new FrameBudget(1)
    for (let i = 0; i < 60; i++) {
      budget.sample(1 / 30)
    }
    const worst = budget.worstFps
    budget.reset()
    for (let i = 0; i < 20; i++) {
      budget.sample(1 / 60)
    }
    expect(budget.worstFps).toBe(worst)
  })
})
