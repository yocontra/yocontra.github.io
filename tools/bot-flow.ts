// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/style/noMagicNumbers: window lengths and thresholds in seconds and metres
/**
 * Bots on Perdition, headless: 32 server bots play the town for a few minutes in-process (the
 * real sim and the real BotDirector on the layout's nav grid) and this reports whether any got
 * stuck and how the fight spread over the map.
 *
 *   bun tools/bot-flow.ts [seconds=300] [--layout=path.json]
 *
 * Stuck: alive for a whole 10 s window without moving 1.5 m. Also prints kills, deposits, where
 * bots died (by map quarter) and how many of the bank's doors were used. Exit code 1 if stuck.
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { BotDirector, botName } from '../api/src/town/bots.ts'
import { TICK_HZ } from '../src/experiments/out-west/ffa/sim/constants.ts'
import { TOWN, type TownLayout } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { createWorld } from '../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame } from '../src/experiments/out-west/ffa/sim/types.ts'
import { addPlayer, step } from '../src/experiments/out-west/ffa/sim/world.ts'

const NUMBER = /^\d+$/u
const seconds = Number(process.argv.find((a) => NUMBER.test(a)) ?? 300)
const path = process.argv.find((a) => a.startsWith('--layout='))?.slice(9)
const layout: TownLayout = path ? (JSON.parse(readFileSync(path, 'utf8')) as TownLayout) : TOWN

const PLAYERS = 32
const WINDOW = 10 * TICK_HZ
const seed = Number(process.argv.find((a) => a.startsWith('--seed='))?.slice(7) ?? 7)
const w = createWorld({ seed, layout })
const bots = new BotDirector(seed)
for (let i = 0; i < PLAYERS; i++) {
  addPlayer(w, { accountId: `bot-${i}`, name: botName(i), level: 1, prestige: 0, bot: true })
}
const start = new Map<number, { x: number; z: number; spawn: number }>()
let stuck = 0
let windows = 0
const stuckAt: string[] = []
let kills = 0
let deposits = 0
const deaths = [0, 0, 0, 0]
const heat = new Map<string, number>()
for (let t = 0; t < seconds * TICK_HZ; t++) {
  const frames: (InputFrame | null)[] = []
  bots.frames(w, frames)
  step(w, frames)
  for (const e of w.events) {
    if (e.type === 'kill') {
      kills++
      const v = w.players[e.victim]
      if (v) {
        deaths[(v.x > layout.size / 2 ? 1 : 0) + (v.z > layout.size / 2 ? 2 : 0)]++
        const key = `${Math.floor(v.x / 24)},${Math.floor(v.z / 24)}`
        heat.set(key, (heat.get(key) ?? 0) + 1)
      }
    }
  }
  deposits += w.deposits.length
  w.deposits.length = 0
  if (t % WINDOW === 0) {
    for (const p of w.players) {
      if (!p) {
        continue
      }
      const s = start.get(p.id)
      if (s && p.alive && p.spawnTick === s.spawn) {
        windows++
        if (Math.hypot(p.x - s.x, p.z - s.z) < 1.5) {
          stuck++
          stuckAt.push(`${p.name} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) t=${t / TICK_HZ}s`)
        }
      }
      start.set(p.id, { x: p.x, z: p.z, spawn: p.spawnTick })
    }
  }
}
console.log(
  `${layout.name} v${layout.version}: ${PLAYERS} bots, ${seconds} s: ${kills} kills, ${deposits} deposits`,
)
console.log(`  stuck windows ${stuck} / ${windows}`)
for (const s of stuckAt.slice(0, 20)) {
  console.log(`    ${s}`)
}
console.log(`  deaths by quarter (NW NE SW SE): ${deaths.join(' ')}`)
const cells = [...heat.entries()].toSorted((a, b) => b[1] - a[1])
console.log(
  `  hottest 24 m cells: ${cells
    .slice(0, 6)
    .map(([k, n]) => `${k}:${n}`)
    .join('  ')}  (${cells.length} cells saw a kill)`,
)
process.exit(stuck > 0 ? 1 : 0)
