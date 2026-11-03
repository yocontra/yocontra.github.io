import { describe, expect, it } from 'bun:test'
import { judgedReaction, looksAutomated, rttStats, tolerance } from './judge.ts'

describe('rttStats', () => {
  it('median and median absolute deviation', () => {
    expect(rttStats([40, 50, 60])).toEqual({ median: 50, jitter: 10 })
    expect(rttStats([40, 50, 60, 1000]).median).toBe(55)
  })
  it('no samples means maximum caution', () => {
    expect(rttStats([]).jitter).toBeGreaterThan(100)
  })
})

describe('judgedReaction', () => {
  const rtt = { median: 60, jitter: 5 }

  it('trusts an honest client measurement', () => {
    // Server saw 300 ms; minus 60 ms RTT ≈ 240 ms. Client says 235 ms: consistent, so use it.
    expect(judgedReaction(300, 235, rtt)).toBe(235)
  })

  it('clamps a client that claims to be faster than the server could have seen', () => {
    // Server view ≈ 240 ms, tolerance 40 ms → nothing faster than 200 ms is believable.
    expect(judgedReaction(300, 120, rtt)).toBe(300 - 60 - tolerance(rtt))
  })

  it('falls back to the server view when the client sends nothing', () => {
    expect(judgedReaction(300, null, rtt)).toBe(240)
  })

  it('a laggy player is not punished for their connection', () => {
    const laggy = { median: 250, jitter: 10 }
    expect(judgedReaction(480, 225, laggy)).toBe(225)
  })
})

describe('looksAutomated', () => {
  it('flags robotic consistency', () => {
    expect(looksAutomated([180, 181, 180, 182, 181, 180])).toBe(true)
  })
  it('accepts human spread', () => {
    expect(looksAutomated([212, 260, 198, 305, 240, 228])).toBe(false)
  })
  it('needs enough samples to judge', () => {
    expect(looksAutomated([180, 180, 180])).toBe(false)
  })
})
