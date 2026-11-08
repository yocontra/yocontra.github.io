/**
 * The practice town, measured: one scripted "new player" in a loopback-shaped lobby (the real
 * `LobbyCore`, ambient bots and all) for N minutes of sim time, reporting kill/death, average life,
 * time to the first bank and money banked. The player plays like the premium reviewer's harness:
 * a perfect yaw lock 250 ms after a target shows, a shot every 380–630 ms, and it walks to bags and
 * then the bank. Runs in a couple of seconds per sim-minute.
 *
 *   bun api/src/town/practice-bench.ts [minutes=10] [runs=6] [record=off|new|mid|vet] [hand=reviewer|novice]
 *
 * `off` is a live lobby's rules (no practice); `new`, `mid` and `vet` are practice records of 0, 6
 * and 30 rounds.
 */
import { argv, stdout } from 'node:process'
import { file } from 'bun'
import {
  BTN_AIM,
  BTN_FIRE,
  BTN_INTERACT,
  BTN_RELOAD,
  BTN_SPRINT,
  KILL_PARDON,
} from '../../../src/experiments/out-west/contract/town.ts'
import { MAX_RANGE, TICK_HZ } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { hasLineOfSight, zoneAt } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { radiansToAim } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'
import {
  activePlayers,
  dist2,
  type World,
} from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { Player } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { initializeAmmo } from '../../../src/experiments/out-west/runtime/ammo.ts'
import { COLLISION } from '../../../src/experiments/out-west/runtime/collision.ts'
import { createFrontierSimulation } from '../../../src/experiments/out-west/runtime/frontier.ts'
import { LobbyCore } from './core.ts'
import { buildNav, findPath, type NavGrid, nextWaypoint } from './nav.ts'
import type { PracticeOptions } from './practice.ts'

export interface PracticeResult {
  kills: number
  deaths: number
  /** Mean seconds alive per life (the life in progress at the end counts). */
  avgLife: number
  /** Seconds from joining to the first deposit, or null. */
  firstBank: number | null
  banked: number
  botKills: number
  pardoned: number
}

/** How the scripted player shoots: the reviewer's harness (a perfect lock) or a new human. */
export interface Hand {
  reactTicks: number
  /** Aim error (rad, a rough bell curve re-picked twice a second). */
  wanderRad: number
  fireMin: number
  fireMax: number
}

export const HANDS: Record<string, Hand> = {
  reviewer: { reactTicks: 5, wanderRad: 0, fireMin: 8, fireMax: 13 },
  novice: { reactTicks: 9, wanderRad: 0.07, fireMin: 9, fireMax: 16 },
}

/** The reviewer-shaped player: perfect aim after a beat, walks to money and then to the bank. */
export class PracticePilot {
  private readonly rng: Rng
  private readonly nav: NavGrid
  private target = -1
  private seenAt = 0
  private nextFire = 0
  private path: { x: number; z: number }[] = []
  private replanAt = 0
  private strafe = 1
  private lastButtons = 0
  private readonly hand: Hand
  private wander = 0
  private wanderAt = 0

  constructor(w: World, seed: number, hand: Hand) {
    this.hand = hand
    this.rng = new Rng(seed)
    this.nav = buildNav(w.grid)
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one scripted player's whole policy, flat
  frame(w: World, p: Player): { moveX: number; moveZ: number; aim: number; buttons: number } {
    const out = { moveX: 0, moveZ: 0, aim: radiansToAim(0), buttons: 0 }
    if (!p.alive) {
      this.target = -1
      this.path = []
      return out
    }
    let best: Player | null = null
    let bestD = MAX_RANGE ** 2
    for (const q of activePlayers(w)) {
      if (q === p || !q.alive || q.showdown >= 0) {
        continue
      }
      const d2 = dist2(p.x, p.z, q.x, q.z)
      if (d2 < bestD && hasLineOfSight(w.grid, p, q)) {
        bestD = d2
        best = q
      }
    }
    if (best?.id !== this.target) {
      this.target = best?.id ?? -1
      this.seenAt = w.tick
    }
    if (best && w.tick - this.seenAt >= this.hand.reactTicks) {
      const dx = best.x - p.x
      const dz = best.z - p.z
      if (w.tick >= this.wanderAt) {
        this.wanderAt = w.tick + 10
        const g = this.rng.next() + this.rng.next() + this.rng.next() - 1.5
        this.wander = g * 2 * this.hand.wanderRad
      }
      out.aim = radiansToAim(Math.atan2(dz, dx) + this.wander)
      out.buttons |= BTN_AIM
      if (w.tick >= this.nextFire && !(this.lastButtons & BTN_FIRE)) {
        out.buttons |= BTN_FIRE
        this.nextFire = w.tick + this.rng.int(this.hand.fireMin, this.hand.fireMax)
      }
      if (p.ammo === 0) {
        out.buttons |= BTN_RELOAD
      }
      if (this.rng.next() < 0.03) {
        this.strafe = -this.strafe
      }
      const d = Math.sqrt(dx * dx + dz * dz) || 1
      out.moveX = Math.round((-dz / d) * this.strafe * 90)
      out.moveZ = Math.round((dx / d) * this.strafe * 90)
      this.lastButtons = out.buttons
      return out
    }
    // Nothing to shoot: money first, then the bank, else roam.
    if (w.tick >= this.replanAt || this.path.length === 0) {
      this.replanAt = w.tick + 20
      const goal = this.goal(w, p)
      this.path = findPath(this.nav, p, goal) ?? []
    }
    const next = nextWaypoint(w.grid, this.path, p)
    const zone = zoneAt(w.layout, p.x, p.z)
    if (zone && p.carried > 0) {
      out.buttons = this.lastButtons & BTN_INTERACT ? 0 : BTN_INTERACT
      if (p.channel) {
        out.buttons = 0
      }
      this.lastButtons = out.buttons
      return out
    }
    if (next) {
      const dx = next.x - p.x
      const dz = next.z - p.z
      const d = Math.sqrt(dx * dx + dz * dz) || 1
      out.moveX = Math.round((dx / d) * 127)
      out.moveZ = Math.round((dz / d) * 127)
      out.aim = radiansToAim(Math.atan2(dz, dx))
      out.buttons |= BTN_SPRINT
    }
    this.lastButtons = out.buttons
    return out
  }

  private goal(w: World, p: Player): { x: number; z: number } {
    if (p.carried > 0) {
      let best = w.layout.zones[0] ?? { x: 72, z: 81 }
      for (const z of w.layout.zones) {
        if (z.kind === 'bank' && dist2(p.x, p.z, z.x, z.z) < dist2(p.x, p.z, best.x, best.z)) {
          best = z
        }
      }
      return best
    }
    let bag: { x: number; z: number } | null = null
    for (const b of w.bags) {
      if (!bag || dist2(p.x, p.z, b.x, b.z) < dist2(p.x, p.z, bag.x, bag.z)) {
        bag = b
      }
    }
    if (bag && dist2(p.x, p.z, bag.x, bag.z) < 40 ** 2) {
      return bag
    }
    const spawns = w.layout.spawns
    return spawns[this.rng.int(0, spawns.length - 1)] ?? { x: 72, z: 64 }
  }
}

/** This tick's events, counted for you (`me`). */
function tally(
  w: World,
  me: number,
  res: PracticeResult,
  life: { start: number; lives: number[] },
): void {
  for (const ev of w.events) {
    if (ev.type === 'kill' && ev.victim === me) {
      res.deaths++
      life.lives.push((w.tick - life.start) / TICK_HZ)
    } else if (ev.type === 'kill' && ev.killer === me) {
      res.kills++
      res.pardoned += ev.flags & KILL_PARDON ? 1 : 0
      res.botKills += w.players[ev.victim]?.bot ? 1 : 0
    } else if (ev.type === 'respawn' && ev.player === me) {
      life.start = w.tick
    } else if (ev.type === 'deposit' && ev.player === me) {
      res.banked += ev.amount + ev.commission
      res.firstBank ??= w.tick / TICK_HZ
    }
  }
}

export async function practiceRun(
  minutes: number,
  seed: number,
  practice: PracticeOptions | null,
  hand: Hand = HANDS.reviewer as Hand,
): Promise<PracticeResult> {
  const ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file(
        new URL('../../../public/experiments/out-west/physics/ammo.wasm.wasm', import.meta.url),
      ).arrayBuffer(),
    ),
  )
  const simulation = createFrontierSimulation({ ammo, collision: COLLISION, seed })
  try {
    const core = new LobbyCore('bench', seed)
    core.world = simulation.world
    core.botTarget = 15
    if (practice) {
      core.usePractice(practice)
    }
    const s = core.join(
      {
        accountId: 'you',
        name: 'You',
        level: 7,
        prestige: 0,
        loadout: [],
        banked: 0,
        tcpRtt: null,
        ledger: false,
      },
      { send: () => undefined, close: () => undefined },
      0,
    )
    if (!s) {
      throw new Error('no session')
    }
    const me = s.playerId
    const brain = new PracticePilot(core.world, seed ^ 0x77, hand)
    const res: PracticeResult = {
      kills: 0,
      deaths: 0,
      avgLife: 0,
      firstBank: null,
      banked: 0,
      botKills: 0,
      pardoned: 0,
    }
    const life = { start: 0, lives: [] as number[] }
    const ticks = minutes * 60 * TICK_HZ
    for (let t = 0; t < ticks; t++) {
      const w = core.world
      const p = w.players[me]
      const frames: (
        | import('../../../src/experiments/out-west/ffa/sim/types.ts').InputFrame
        | null
      )[] = []
      if (p) {
        frames[me] = { ...brain.frame(w, p), seq: t, viewTime: Math.max(0, w.tick - 2), pitch: 0 }
      }
      const out = core.tick(t * 50, { frames })
      for (const d of out.deposits) {
        core.confirmDeposit(d, true)
      }
      tally(core.world, me, res, life)
    }
    if (core.world.players[me]?.alive) {
      life.lives.push((core.world.tick - life.start) / TICK_HZ)
    }
    const lives = life.lives
    res.avgLife = lives.reduce((a, b) => a + b, 0) / Math.max(1, lives.length)
    return res
  } finally {
    simulation.dispose()
  }
}

if (import.meta.main) {
  const minutes = Number(argv[2] ?? 10)
  const runs = Number(argv[3] ?? 6)
  const record = argv[4] ?? 'off'
  const hand = HANDS[argv[5] ?? 'reviewer'] ?? (HANDS.reviewer as Hand)
  const practice: PracticeOptions | null =
    record === 'off' ? null : { rounds: { new: 0, mid: 6, vet: 30 }[record] ?? 0, kd: 1 }
  const all: PracticeResult[] = []
  for (let i = 0; i < runs; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: independent runs are deliberately sequential to bound native physics memory
    const r = await practiceRun(minutes, 1000 + i * 77, practice, hand)
    all.push(r)
    stdout.write(`${JSON.stringify(r)}\n`)
  }
  const sum = (k: keyof PracticeResult): number =>
    all.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
  const banks = all.map((r) => r.firstBank).filter((x): x is number => x !== null)
  stdout.write(
    `${JSON.stringify({
      kd: Number((sum('kills') / Math.max(1, sum('deaths'))).toFixed(2)),
      killsPerRun: Number((sum('kills') / runs).toFixed(1)),
      deathsPerRun: Number((sum('deaths') / runs).toFixed(1)),
      avgLife: Number((sum('avgLife') / runs).toFixed(1)),
      firstBankMedian: banks.toSorted((a, b) => a - b)[Math.floor(banks.length / 2)] ?? null,
      banksMissing: runs - banks.length,
      bankedPerRun: Math.round(sum('banked') / runs),
    })}\n`,
  )
}
