// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one millisecond-stepped loop plays client, network and lobby
/**
 * Input timing end to end, without sockets: a client's `InputBatcher` paced by `TickClock`, a
 * network with lag, jitter (in order, like TCP) and a client that stalls, and the lobby's
 * `InputQueue` echoing `inputLead`. A frame the server consumes before it arrives is applied a
 * tick late in place of a repeat, which is a misprediction (a reconciliation correction on screen).
 * The test counts those.
 */
import { describe, expect, test as it } from 'bun:test'
import { INPUT_LEAD_NONE } from '../../../src/experiments/out-west/contract/town.ts'
import { TickClock } from '../../../src/experiments/out-west/ffa/client/tick-clock.ts'
import type { WireFrame } from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import { TICK_MS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { InputBatcher } from '../../../src/experiments/out-west/ffa/sim/input.ts'
import { InputQueue } from '../../../src/experiments/out-west/ffa/sim/input-queue.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'

interface Net {
  oneWayMs: number
  jitterMs: number
  /** Client clock rate against the server's (0.99: the client's ticks come 1% slow). */
  drift?: number
  /** Wall-clock ms at which the client freezes, and for how long (its ticks are lost). */
  stalls?: [number, number][]
  paced: boolean
  seconds?: number
}

interface Result {
  /** Frames the server applied with content other than the client's frame of that number. */
  mispredicted: number
  consumed: number
  skips: number
  /** Mean ticks between a frame being made and being applied (input latency). */
  meanDelayTicks: number
}

function simulate(net: Net, seed = 7): Result {
  const rng = new Rng(seed)
  const clock = new TickClock()
  const batcher = new InputBatcher()
  const queue = new InputQueue()
  const made = new Map<number, { frame: WireFrame; at: number }>()
  const up: { at: number; seq: number; frames: WireFrame[] }[] = []
  const down: { at: number; lead: number }[] = []
  let lastUp = 0
  let lastDown = 0
  const due = (prev: number, now: number): number =>
    Math.max(prev, now + net.oneWayMs + rng.next() * net.jitterMs)
  let acc = 0
  let nextServer = TICK_MS * 0.37
  let mispredicted = 0
  let consumed = 0
  let skips = 0
  let delaySum = 0
  const applied: { seq: number; moveX: number; at: number }[] = []
  const end = (net.seconds ?? 60) * 1000
  for (let now = 0; now < end; now++) {
    const stalled = (net.stalls ?? []).some(([at, ms]) => now >= at && now < at + ms)
    if (!stalled) {
      acc += net.drift ?? 1
    }
    const period = net.paced ? clock.period : TICK_MS
    while (acc >= period) {
      acc -= period
      // Content changes every tick, so any repeat in its place is a misprediction.
      const seq = batcher.nextSeq
      const frame: WireFrame = {
        moveX: ((seq * 37) % 255) - 127,
        moveZ: 0,
        aim: 0,
        buttons: 0,
        viewTick: 0,
        viewFrac: 0,
      }
      made.set(seq, { frame, at: now })
      const out = batcher.push(frame)
      if (out) {
        lastUp = due(lastUp, now)
        up.push({ at: lastUp, ...out })
      }
    }
    while (up[0] && up[0].at <= now) {
      const m = up.shift()
      if (m) {
        queue.push(m.seq, m.frames)
      }
    }
    if (now >= nextServer) {
      nextServer += TICK_MS
      const next = queue.next()
      if (next) {
        consumed++
        // Compared once the run is over: a client running behind hasn't even made this frame yet.
        if (now > 3000) {
          applied.push({ seq: next.seq, moveX: next.frame.moveX, at: now })
        }
      }
      lastDown = due(lastDown, now)
      down.push({ at: lastDown, lead: queue.takeLead() })
    }
    while (down[0] && down[0].at <= now) {
      const s = down.shift()
      if (s && net.paced) {
        const skip = clock.observe(s.lead === INPUT_LEAD_NONE ? null : s.lead, now)
        if (skip > 0) {
          skips++
          const flush = batcher.skip(skip)
          if (flush) {
            lastUp = due(lastUp, now)
            up.push({ at: lastUp, ...flush })
          }
        }
      }
    }
  }
  for (const a of applied) {
    const want = made.get(a.seq)
    if (!want) {
      // skipped: the client never made (or predicted) a frame with this number
      continue
    }
    if (want.frame.moveX === a.moveX) {
      delaySum += (a.at - want.at) / TICK_MS
    } else {
      mispredicted++
    }
  }
  return {
    mispredicted,
    consumed,
    skips,
    meanDelayTicks: delaySum / Math.max(1, applied.length),
  }
}

describe('input pacing (TickClock + InputQueue.inputLead)', () => {
  it('reports how early each message arrived, and nothing when none did', () => {
    const q = new InputQueue()
    const f: WireFrame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }
    q.push(10, [f, f])
    expect(q.takeLead()).toBe(INPUT_LEAD_NONE)
    q.push(14, [f, f])
    q.push(16, [f, f])
    // The queue starts at 10: the message at 14 is 4 ticks early, 16 is 6; the window keeps the worst.
    expect(q.takeLead()).toBe(4)
    expect(q.takeLead()).toBe(INPUT_LEAD_NONE)
    q.next()
    q.next()
    q.next()
    q.next()
    // 10–13 consumed: 12 arrives 2 ticks late
    q.push(12, [f])
    expect(q.takeLead()).toBe(-2)
  })

  it('a skip sends the half-filled slot and moves the numbering on', () => {
    const b = new InputBatcher()
    const f: WireFrame = { moveX: 5, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }
    b.push(f)
    b.push(f)
    b.push(f)
    expect(b.skip(4)).toEqual({ seq: 2, frames: [f] })
    expect(b.nextSeq).toBe(7)
    b.push(f)
    // the next full slot goes out even though nothing changed (the queue re-anchors on it)
    expect(b.push(f)?.seq).toBe(7)
  })

  it('keeps frames on time through jitter, drift and stalls (and the old fixed clock did not)', () => {
    const cases: Net[] = [
      { oneWayMs: 30, jitterMs: 20, paced: true },
      { oneWayMs: 60, jitterMs: 30, paced: true },
      { oneWayMs: 60, jitterMs: 30, drift: 0.995, paced: true },
      { oneWayMs: 40, jitterMs: 25, drift: 1.004, paced: true },
      {
        oneWayMs: 50,
        jitterMs: 25,
        stalls: [
          [8000, 300],
          [20_000, 1500],
          [35_000, 250],
        ],
        paced: true,
      },
    ]
    for (const net of cases) {
      const r = simulate(net)
      // A stall costs a few frames until the clock hears about it (a round trip); jitter spikes
      // past the margin may cost one now and then; a steady stream is the bug.
      const stalls = net.stalls?.length ?? 0
      expect(r.mispredicted).toBeLessThanOrEqual(stalls * 8 + r.consumed * 0.005)
      // and the margin stays small: under ~4 ticks of input latency beyond the one-way trip
      expect(r.meanDelayTicks).toBeLessThan(net.oneWayMs / TICK_MS + 5)
    }
    const old = simulate({
      oneWayMs: 50,
      jitterMs: 25,
      stalls: [[8000, 300]],
      paced: false,
    })
    expect(old.mispredicted).toBeGreaterThan(old.consumed * 0.3)
  })

  it('recovers from a long stall by skipping ahead, not by crawling', () => {
    const r = simulate({ oneWayMs: 40, jitterMs: 10, stalls: [[5000, 3000]], paced: true })
    expect(r.skips).toBeGreaterThanOrEqual(1)
    expect(r.mispredicted).toBeLessThan(30)
  })
})
