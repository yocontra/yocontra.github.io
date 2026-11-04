/**
 * Server bots: simple waypoint fighters that keep the town lively and drive load tests. They play
 * through the same input frames as humans, so they exercise every server path. Bots never keep a
 * lobby awake: the lobby only ticks while a human is connected.
 */
import {
  BTN_AIM,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_INTERACT,
  BTN_JUMP,
  BTN_RELOAD,
  BTN_ROLL,
  BTN_SPRINT,
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
/** At the goal with nothing to channel: the next goal this soon (ticks). */
const ARRIVED_REPLAN_TICKS = 3
/** Closer than this (m), two fighters back off from each other instead of trading point-blank. */
const POINT_BLANK_M = 1.5
/** Walking without moving for this long (ticks): pick another goal. */
const STUCK_TICKS = 15
const SCAN_TICKS = 4
const AIM_ERROR_RAD = 0.06
/** Dev `rally` only: bots further than this from the rally player stop fighting and walk back. */
const RALLY_LEASH = 7
/** Dev `rally` only: the crowd fires outward from the rally point, give or take this (rad). */
const RALLY_AIM_JITTER = 0.5
const FIRST_NAMES = ['Dusty', 'Lefty', 'Calamity', 'Doc', 'Mad', 'Silent', 'Coyote', 'Belle']
const LAST_NAMES = ['Malone', 'Hollis', 'Black', 'Starling', 'Pike', 'Varga', 'Crowe', 'Tate']
/** 64 distinct first × last names, ordered so neighbours share neither half. */
const BOT_NAMES: readonly string[] = Array.from(
  { length: FIRST_NAMES.length * LAST_NAMES.length },
  (_, n) => {
    const first = n % FIRST_NAMES.length
    const last = (first + Math.floor(n / FIRST_NAMES.length)) % LAST_NAMES.length
    return `${FIRST_NAMES[first] ?? 'Drifter'} ${LAST_NAMES[last] ?? 'Jones'}`
  },
)

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
  /** Where the bot stood last tick and how many ticks it has walked without getting anywhere. */
  lastX: number
  lastZ: number
  stuck: number
  /** Not before this tick: the next slide. */
  slideAt: number
}

/** The `n`th bot name (64 distinct, then they repeat). */
export const botName = (n: number): string => BOT_NAMES[n % BOT_NAMES.length] ?? 'Drifter'

/** A bot name nobody in `inUse` has, starting from `seed`: unique for up to 64 bots, no suffixes. */
export function freshBotName(seed: number, inUse: ReadonlySet<string>): string {
  for (let i = 0; i < BOT_NAMES.length; i++) {
    const name = botName(seed + i)
    if (!inUse.has(name)) {
      return name
    }
  }
  return botName(seed)
}

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
  /**
   * Dev perf harness only (the loopback's `?cluster`): every bot loiters within a few metres of
   * this player and never targets them, so 20+ riders fight on screen around a live camera.
   */
  rally: number = NONE

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
      b = {
        path: [],
        goal: null,
        replanAt: 0,
        target: -1,
        scanAt: 0,
        strafe: 1,
        seq: 0,
        lastX: 0,
        lastZ: 0,
        stuck: 0,
        slideAt: 0,
      }
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
    const host = this.rally === NONE ? null : w.players[this.rally]
    if (host?.alive) {
      return { x: host.x + this.rng.range(-5, 5), z: host.z + this.rng.range(-3.5, 3.5) }
    }
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
    let dx = q.x - p.x
    let dz = q.z - p.z
    if (dx * dx + dz * dz < POINT_BLANK_M ** 2) {
      // On top of each other (a shared goal, a shared doorway): with no direction between them
      // they'd stand and trade shots forever. Each backs off its own way (by id) and circles.
      const a = (p.id * 2.399_963) % (Math.PI * 2)
      dx = Math.cos(a) * POINT_BLANK_M
      dz = Math.sin(a) * POINT_BLANK_M
    }
    const d = Math.sqrt(dx * dx + dz * dz) || 1
    f.aim = radiansToAim(Math.atan2(dz, dx) + this.rng.range(-AIM_ERROR_RAD, AIM_ERROR_RAD))
    // Strafe around the target, closing to ~10 m.
    if (this.rng.next() < 0.03) {
      b.strafe = -b.strafe
    }
    let approach = 0
    if (d > 12) {
      approach = 1
    } else if (d <= POINT_BLANK_M) {
      approach = -1
    } else if (d < 7) {
      approach = -0.6
    }
    f.moveX = Math.round(((dx / d) * approach - (dz / d) * b.strafe * 0.8) * 100)
    f.moveZ = Math.round(((dz / d) * approach + (dx / d) * b.strafe * 0.8) * 100)
    const fireNow = (w.tick + p.id) % 7 === 0
    f.buttons = fireNow ? BTN_FIRE : 0
    // CoD habits (wire v5), so riders read as shooters: on the sights at range, some crouch to
    // shoot (by temperament, in spells), the odd jump while strafing
    const spell = Math.floor((w.tick + p.id * 37) / 60)
    if (d > 6 && (spell + p.id) % 4 !== 0) {
      f.buttons |= BTN_AIM
    }
    if (d > 8 && p.id % 3 === 0 && spell % 2 === 0) {
      f.buttons |= BTN_CROUCH
    }
    if (d < 9 && this.rng.next() < 0.012) {
      f.buttons |= BTN_JUMP
    }
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
    // Pushing into a corner the nav grid thinks is open (or another rider): give up on this goal.
    b.stuck = dist2(p.x, p.z, b.lastX, b.lastZ) < 0.05 ** 2 && b.path.length > 0 ? b.stuck + 1 : 0
    b.lastX = p.x
    b.lastZ = p.z
    if (b.stuck >= STUCK_TICKS) {
      b.stuck = 0
      b.replanAt = 0
    }
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
      // At the goal: press E (bank, open the box). If no channel starts within a few ticks there
      // was nothing to do here: pick the next goal at once rather than idling until the replan.
      f.buttons = p.lastButtons & BTN_INTERACT ? 0 : BTN_INTERACT
      b.replanAt = Math.min(b.replanAt, w.tick + ARRIVED_REPLAN_TICKS)
      return
    }
    const dx = next.x - p.x
    const dz = next.z - p.z
    const d = Math.sqrt(dx * dx + dz * dz) || 1
    f.moveX = Math.round((dx / d) * 127)
    f.moveZ = Math.round((dz / d) * 127)
    f.aim = radiansToAim(Math.atan2(dz, dx))
    // travelling: sprint on the long legs, and now and then slide into a corner or hop
    if (b.path.length > 2) {
      f.buttons |= BTN_SPRINT
      if (p.sprinting && b.slideAt <= w.tick && this.rng.next() < 0.02) {
        f.buttons |= BTN_CROUCH
        b.slideAt = w.tick + 80
      } else if (this.rng.next() < 0.006) {
        f.buttons |= BTN_JUMP
      }
    }
  }

  /**
   * A rally is a crowd, not a massacre: they circle the rally point and shoot (tracers, muzzle
   * flashes, sound) outward, away from the crowd, so it stays on its feet around you.
   */
  private rallyFight(p: Player, b: BotBrain, f: InputFrame, host: Player): void {
    const hx = host.x - p.x
    const hz = host.z - p.z
    const hd = Math.hypot(hx, hz) || 1
    f.aim = radiansToAim(Math.atan2(-hz, -hx) + this.rng.range(-RALLY_AIM_JITTER, RALLY_AIM_JITTER))
    f.buttons &= ~BTN_THROW
    const pull = hd > 5 ? 1 : 0
    f.moveX = Math.round(((hx / hd) * pull - (hz / hd) * b.strafe * 0.5) * 100)
    f.moveZ = Math.round(((hz / hd) * pull + (hx / hd) * b.strafe * 0.5) * 100)
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
      scanForTarget(w, p, b, this.rally)
    }
    const q = b.target >= 0 ? w.players[b.target] : null
    const host = this.rally === NONE ? null : w.players[this.rally]
    const straying = host?.alive === true && dist2(p.x, p.z, host.x, host.z) > RALLY_LEASH ** 2
    if (q?.alive && p.carried < BANK_AT * 2 && !straying) {
      this.fight({ w, p, b, q, f })
      if (host) {
        this.rallyFight(p, b, f, host)
      }
    } else {
      if (
        straying &&
        host &&
        b.goal &&
        dist2(b.goal.x, b.goal.z, host.x, host.z) > RALLY_LEASH ** 2
      ) {
        b.replanAt = 0
      }
      this.walk(w, p, b, f)
    }
    return f
  }
}

function scanForTarget(w: World, p: Player, b: BotBrain, spare: number): void {
  b.scanAt = w.tick + SCAN_TICKS
  b.target = -1
  let best = ENGAGE_RANGE ** 2
  for (const q of activePlayers(w)) {
    if (q.id === p.id || q.id === spare || !q.alive || q.showdown >= 0) {
      continue
    }
    const d2 = dist2(p.x, p.z, q.x, q.z)
    if (d2 < best && hasLineOfSight(w.grid, p, q)) {
      best = d2
      b.target = q.id
    }
  }
}
