/** A deterministic clock for standoff and room tests. */
import type { Clock } from './standoff.ts'

interface Timer {
  at: number
  seq: number
  fn: () => void
}

export class FakeClock implements Clock {
  private t: number
  private seq = 0
  private timers: Timer[] = []

  constructor(start = 1_000_000) {
    this.t = start
  }

  now = (): number => this.t

  after = (ms: number, fn: () => void): (() => void) => {
    const timer = { at: this.t + Math.max(0, ms), seq: this.seq++, fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((x) => x !== timer)
    }
  }

  /** Advance time by `ms`, firing every timer due on the way, in order. */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) {
        break
      }
      this.timers = this.timers.filter((x) => x !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
    }
    this.t = end
  }

  get pending(): number {
    return this.timers.length
  }
}

/** A seeded PRNG (mulberry32) so tests can pin random draws. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
