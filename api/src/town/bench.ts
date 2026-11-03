/**
 * In-process tick benchmark: N bots in one world, every tick = input decode + sim step + one
 * snapshot encode per player (the full per-tick work of a Lobby DO, minus socket I/O).
 *
 *   bun api/src/town/bench.ts [players=32] [seconds=300]
 */

import { argv, stdout } from 'node:process'
import { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import { decodeInput, encodeInput } from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import { TICK_HZ } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { ClientStream, snapshotFor } from '../../../src/experiments/out-west/ffa/sim/snapshot.ts'
import { createWorld } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { addPlayer, step } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { BotDirector, botName } from './bots.ts'

export interface BenchResult {
  players: number
  ticks: number
  tickMs: { p50: number; p95: number; p99: number; max: number; mean: number }
  simMs: { p50: number; p99: number }
  encodeMs: { p50: number; p99: number }
  bytesPerClientPerSec: { mean: number; p95Client: number; max: number }
  snapshotBytes: { mean: number; p99: number }
  kills: number
  deposits: number
  minted: number
  burned: number
}

const pct = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0

export function bench(players: number, seconds: number, seed = 42): BenchResult {
  const w = createWorld({ seed })
  const bots = new BotDirector(seed)
  for (let i = 0; i < players; i++) {
    addPlayer(w, {
      accountId: `bot-${i}`,
      name: botName(i),
      level: 1 + (i % 30),
      prestige: 0,
      bot: true,
    })
  }
  const streams = Array.from({ length: players }, () => new ClientStream())
  const sent = new Float64Array(players)
  const writer = new Writer()
  const inWriter = new Writer(64)
  const ticks = seconds * TICK_HZ
  const tickTimes: number[] = []
  const simTimes: number[] = []
  const encTimes: number[] = []
  const sizes: number[] = []
  let kills = 0
  let deposits = 0
  const pending: InputFrame[][] = Array.from({ length: players }, () => [])
  for (let t = 0; t < ticks; t++) {
    const frames: (InputFrame | null)[] = []
    bots.frames(w, frames)
    const t0 = performance.now()
    // Model the wire: every other tick each client sends a 2-frame message that we decode.
    for (let id = 0; id < players; id++) {
      const f = frames[id]
      const queue = pending[id]
      if (f && queue) {
        queue.push(f)
        if (queue.length === 2) {
          const bytes = encodeInput(inWriter, {
            seq: f.seq,
            ackTick: w.tick & 0xff_ff,
            ackAgeMs: 20,
            frames: queue.map((q) => ({ ...q, viewTick: q.viewTime & 0xff_ff, viewFrac: 0 })),
          })
          decodeInput(bytes)
          queue.length = 0
        }
      }
    }
    step(w, frames)
    const t1 = performance.now()
    for (let id = 0; id < players; id++) {
      const p = w.players[id]
      const stream = streams[id]
      if (p && stream) {
        const bytes = snapshotFor(w, p, stream, { banked: 1000, events: w.events }, writer)
        sent[id] = (sent[id] ?? 0) + bytes.length + 2
        sizes.push(bytes.length)
      }
    }
    const t2 = performance.now()
    kills += w.events.filter((e) => e.type === 'kill').length
    deposits += w.deposits.length
    w.deposits.length = 0
    tickTimes.push(t2 - t0)
    simTimes.push(t1 - t0)
    encTimes.push(t2 - t1)
  }
  // Discard the first 5 s (JIT warm-up) from timing stats.
  const warm = Math.min(TICK_HZ * 5, Math.floor(ticks / 4))
  const tt = tickTimes.slice(warm).toSorted((a, b) => a - b)
  const st = simTimes.slice(warm).toSorted((a, b) => a - b)
  const et = encTimes.slice(warm).toSorted((a, b) => a - b)
  const perClient = [...sent].map((b) => b / seconds).toSorted((a, b) => a - b)
  const sz = sizes.toSorted((a, b) => a - b)
  return {
    players,
    ticks,
    tickMs: {
      p50: pct(tt, 0.5),
      p95: pct(tt, 0.95),
      p99: pct(tt, 0.99),
      max: tt.at(-1) ?? 0,
      mean: tt.reduce((a, b) => a + b, 0) / Math.max(1, tt.length),
    },
    simMs: { p50: pct(st, 0.5), p99: pct(st, 0.99) },
    encodeMs: { p50: pct(et, 0.5), p99: pct(et, 0.99) },
    bytesPerClientPerSec: {
      mean: perClient.reduce((a, b) => a + b, 0) / Math.max(1, perClient.length),
      p95Client: pct(perClient, 0.95),
      max: perClient.at(-1) ?? 0,
    },
    snapshotBytes: {
      mean: sz.reduce((a, b) => a + b, 0) / Math.max(1, sz.length),
      p99: pct(sz, 0.99),
    },
    kills,
    deposits,
    minted: w.minted,
    burned: w.burned,
  }
}

if (import.meta.main) {
  const players = Number(argv[2] ?? 32)
  const seconds = Number(argv[3] ?? 300)
  stdout.write(`${JSON.stringify(bench(players, seconds), null, 2)}\n`)
}
