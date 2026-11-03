/**
 * Server bots: simple waypoint fighters that keep the town lively and drive load tests. They play
 * through the same input frames as humans, so they exercise every server path. Bots never keep a
 * lobby awake: the lobby only ticks while a human is connected.
 */
import {
  BTN_FIRE,
  BTN_INTERACT,
  BTN_RELOAD,
  BTN_ROLL,
  BTN_THROW,
  NONE,
} from '../../../src/experiments/out-west/contract/town.ts'
import { hasLineOfSight } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { radiansToAim } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'
import {
  activePlayers,
  dist2,
  type World,
} from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame, Player } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { buildNav, findPath, type NavGrid } from './nav.ts'

const ENGAGE_RANGE = 20
const BANK_AT = 300
const REPLAN_TICKS = 40
const SCAN_TICKS = 4
const AIM_ERROR_RAD = 0.06
const BOT_NAMES = [
  'Dusty Pete',
  'One-Eyed Jack',
  'Calamity Sue',
  'Bart Black',
  'Lefty Malone',
  'Doc Hollis',
  'Mad Ike',
  'Rattlesnake Ray',
  'Belle Starling',
  'Coyote Kid',
  'Ugly Hank',
  'Silent Sam',
]

/** The town never changes at runtime, so every lobby in an isolate shares one nav grid. */
let sharedNav: NavGrid | null = null

interface BotBrain {
  path: { x: number; z: number }[]
  goal: { x: number; z: number } | null
  replanAt: number
  target: number
  scanAt: number
  strafe: number
  seq: number
}

export const botName = (n: number): string =>
  `${BOT_NAMES[n % BOT_NAMES.length] ?? 'Drifter'}${n >= BOT_NAMES.length ? ` ${Math.floor(n / BOT_NAMES.length) + 1}` : ''}`

/** One bot (`p`, brain `b`) engaging target `q`, writing its intent into `f`. */
interface Engagement {
  w: World
  p: Player
  b: BotBrain
  q: Player
  f: InputFrame
}

export class BotDirector {
  private readonly brains = new Map<number, BotBrain>()
  private readonly rng: Rng
  private nav: NavGrid | null = null

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x5e_ed)
  }

  forget(id: number): void {
    this.brains.delete(id)
  }

  private navFor(w: World): NavGrid {
    // One per isolate: building it costs a few dozen ms, so new lobbies reuse it.
    sharedNav ??= buildNav(w.grid)
    this.nav ??= sharedNav
    return this.nav
  }

  private brain(id: number): BotBrain {
    let b = this.brains.get(id)
    if (!b) {
      b = { path: [], goal: null, replanAt: 0, target: -1, scanAt: 0, strafe: 1, seq: 0 }
      this.brains.set(id, b)
    }
    return b
  }

  /** One input frame for every bot in the world this tick. */
  frames(w: World, out: (InputFrame | null)[]): void {
    for (const p of activePlayers(w)) {
      if (p.bot) {
        out[p.id] = this.think(w, p)
      }
    }
  }

  private pickGoal(w: World, p: Player): { x: number; z: number } {
    if (p.carried >= BANK_AT) {
      const windows = w.layout.zones
      return windows[this.rng.int(0, windows.length - 1)] ?? { x: 72, z: 80 }
    }
    const box = w.strongbox
    const spot = box ? w.layout.strongboxes[box.spot] : undefined
    if (spot && this.rng.next() < 0.5) {
      return spot
    }
    const bag = w.bags[this.rng.int(0, Math.max(0, w.bags.length - 1))]
    if (bag && this.rng.next() < 0.5) {
      return bag
    }
    const spawns = w.layout.spawns
    return spawns[this.rng.int(0, spawns.length - 1)] ?? { x: 72, z: 64 }
  }

  private fight({ w, p, b, q, f }: Engagement): void {
    const dx = q.x - p.x
    const dz = q.z - p.z
    const d = Math.sqrt(dx * dx + dz * dz) || 1
    f.aim = radiansToAim(Math.atan2(dz, dx) + this.rng.range(-AIM_ERROR_RAD, AIM_ERROR_RAD))
    // Strafe around the target, closing to ~10 m.
    if (this.rng.next() < 0.03) {
      b.strafe = -b.strafe
    }
    let approach = 0
    if (d > 12) {
      approach = 1
    } else if (d < 7) {
      approach = -0.6
    }
    f.moveX = Math.round(((dx / d) * approach - (dz / d) * b.strafe * 0.8) * 100)
    f.moveZ = Math.round(((dz / d) * approach + (dx / d) * b.strafe * 0.8) * 100)
    const fireNow = (w.tick + p.id) % 7 === 0
    f.buttons = fireNow ? BTN_FIRE : 0
    if (p.ammo === 0) {
      f.buttons |= BTN_RELOAD
    }
    if (p.dynamite > 0 && d > 5 && d < 10 && this.rng.next() < 0.1) {
      f.buttons |= BTN_THROW
    }
    if (p.hp < 50 && this.rng.next() < 0.04) {
      f.buttons |= BTN_ROLL
    }
  }

  private walk(w: World, p: Player, b: BotBrain, f: InputFrame): void {
    if (w.tick >= b.replanAt || b.path.length === 0) {
      b.goal = this.pickGoal(w, p)
      b.path = findPath(this.navFor(w), p, b.goal) ?? []
      b.replanAt = w.tick + REPLAN_TICKS + this.rng.int(0, 20)
    }
    let next = b.path[0]
    while (next && dist2(p.x, p.z, next.x, next.z) < 0.6) {
      b.path.shift()
      next = b.path[0]
    }
    if (!next) {
      // At the goal: bank, open the box, or idle.
      f.buttons = (w.tick + p.id) % 4 === 0 ? BTN_INTERACT : 0
      return
    }
    const dx = next.x - p.x
    const dz = next.z - p.z
    const d = Math.sqrt(dx * dx + dz * dz) || 1
    f.moveX = Math.round((dx / d) * 127)
    f.moveZ = Math.round((dz / d) * 127)
    f.aim = radiansToAim(Math.atan2(dz, dx))
  }

  private think(w: World, p: Player): InputFrame {
    const b = this.brain(p.id)
    const f: InputFrame = {
      seq: ++b.seq & 0xff_ff,
      moveX: 0,
      moveZ: 0,
      aim: p.aim,
      buttons: 0,
      viewTime: w.tick - 1,
    }
    if (!p.alive || p.showdown >= 0) {
      b.path = []
      return f
    }
    if (p.calledBy !== NONE) {
      // Accept most call-outs: press, release, press.
      f.buttons = (w.tick + p.id) % 2 === 0 && p.id % 4 !== 0 ? BTN_INTERACT : 0
      return f
    }
    if (p.channel) {
      // Stand still while banking or opening a box.
      return f
    }
    if (w.tick >= b.scanAt) {
      scanForTarget(w, p, b)
    }
    const q = b.target >= 0 ? w.players[b.target] : null
    if (q?.alive && p.carried < BANK_AT * 2) {
      this.fight({ w, p, b, q, f })
    } else {
      this.walk(w, p, b, f)
    }
    return f
  }
}

function scanForTarget(w: World, p: Player, b: BotBrain): void {
  b.scanAt = w.tick + SCAN_TICKS
  b.target = -1
  let best = ENGAGE_RANGE ** 2
  for (const q of activePlayers(w)) {
    if (q.id === p.id || !q.alive || q.showdown >= 0) {
      continue
    }
    const d2 = dist2(p.x, p.z, q.x, q.z)
    if (d2 < best && hasLineOfSight(w.grid, p, q)) {
      best = d2
      b.target = q.id
    }
  }
}
