/**
 * Server bots: waypoint fighters that keep the town lively and drive load tests. They play through
 * the same input frames as humans, so they exercise every server path. Bots never keep a lobby
 * awake: the lobby only ticks while a human is connected.
 *
 * They aim like people, not turrets. Each bot has a skill (0 green … 1 sharp) that sets how long
 * it takes to react to a new target, how fast its aim swings onto one (a moving target out-runs a
 * slow hand), how far its aim wanders (so it misses), its rate of fire and its reach, and how long
 * it remembers someone who ducked behind cover (it hunts them; it doesn't shoot through the wall).
 * No bot shoots a rider in the first seconds after they spawn, and only a few bots gang up on one
 * human at a time. Live lobbies field middling bots; the practice town sets the skill from the
 * player's record (a new player meets green bots, a few sharp ones turn up later) and sharpens the
 * bots fighting a player who is on a streak.
 */
import {
  BTN_AIM,
  BTN_CALLOUT,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_JUMP,
  BTN_RELOAD,
  BTN_ROLL,
  BTN_SPRINT,
  BTN_THROW,
  NONE,
} from '../../../src/experiments/out-west/contract/town.ts'
import { hasLineOfSight } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { aimRadians, radiansToAim } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'
import {
  activePlayers,
  dist2,
  type World,
} from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame, Player } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { aimFor, type BotAim } from './bot-skill.ts'
import { buildNav, findPath, type NavGrid } from './nav.ts'

const BANK_AT = 300
/** Practice bots bank small carries, so the windows are busy and the town reads as alive. */
const PRACTICE_BANK_AT = 80
const REPLAN_TICKS = 40
/** At the goal with nothing to channel: the next goal this soon (ticks). */
const ARRIVED_REPLAN_TICKS = 3
/** Closer than this (m), two fighters back off from each other instead of trading point-blank. */
const POINT_BLANK_M = 1.5
/** Walking without moving for this long (ticks): pick another goal. */
const STUCK_TICKS = 15
const SCAN_TICKS = 4
/** Live lobbies: every bot's skill is this, give or take `LIVE_SKILL_SPREAD`. */
const LIVE_SKILL = 0.55
const LIVE_SKILL_SPREAD = 0.15
/** Practice: one bot in `SHARP_ODDS` is `SHARP_BONUS` better, once the base reaches `SHARP_FROM`. */
const SHARP_BONUS = 0.25
const SHARP_ODDS = 0.2
const SHARP_FROM = 0.35
/** Practice: per kill in the human's current life, the bots fighting them sharpen this much (cap). */
const STREAK_STEP = 0.04
const STREAK_CAP = 0.2
/** Nobody shoots a fresh spawn for this long (ticks): live 3 s (the spawn shield), practice 5 s. */
const SPAWN_GRACE_LIVE = 60
const SPAWN_GRACE_PRACTICE = 100
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
  skill: number
  aim: BotAim
  /** Where the bot's hand points (rad), and its wander: current, goal, and when it re-picks. */
  aimRad: number
  wander: number
  wanderGoal: number
  wanderAt: number
  /** The next trigger pull, and shots left in this burst. */
  fireAt: number
  burstLeft: number
  /** Whether the target was in sight at the last scan; when it went out of sight, and where. */
  visible: boolean
  lostAt: number
  lastSeenX: number
  lastSeenZ: number
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

interface Scan {
  w: World
  p: Player
  b: BotBrain
  /** Bots already fighting each human: only a few gang up on one. */
  pack: Map<number, number>
  grace: number
  spare: number
}

/** The nearest rider in sight and reach, sparing fresh spawns and humans already outnumbered. */
function pickTarget({ w, p, b, pack, grace, spare }: Scan): Player | null {
  let best: Player | null = null
  let bestD = b.aim.range ** 2
  for (const q of activePlayers(w)) {
    if (q.id === p.id || q.id === spare || !q.alive || q.showdown >= 0) {
      continue
    }
    if (w.tick - q.spawnTick < grace) {
      continue
    }
    if (!q.bot && q.id !== b.target && (pack.get(q.id) ?? 0) >= b.aim.pack) {
      continue
    }
    const d2 = dist2(p.x, p.z, q.x, q.z)
    if (d2 < bestD && hasLineOfSight(w.grid, p, q)) {
      bestD = d2
      best = q
    }
  }
  return best
}

export class BotDirector {
  private readonly brains = new Map<number, BotBrain>()
  private readonly rng: Rng
  private nav: NavGrid | null = null
  /**
   * The practice town's base skill (see `practiceSkill`), or null in a live lobby (middling bots).
   * Brains made after it changes use it.
   */
  practiceSkill: number | null = null
  /** Kills in each player's current life (practice: the bots sharpen against a streak). */
  private readonly streak = new Map<number, number>()
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
    this.streak.delete(id)
  }

  /** The practice record changed (a round finished): every bot re-rolls its skill from the base. */
  reskill(): void {
    for (const b of this.brains.values()) {
      b.skill = this.rollSkill()
      b.aim = aimFor(b.skill)
    }
  }

  /** A bot's skill (tests and dev tools), or null for a player without a brain. */
  skillOf(id: number): number | null {
    return this.brains.get(id)?.skill ?? null
  }

  private navFor(w: World): NavGrid {
    // One per isolate: building it costs a few dozen ms, so new lobbies reuse it.
    sharedNav ??= buildNav(w.grid)
    this.nav ??= sharedNav
    return this.nav
  }

  private rollSkill(): number {
    const base = this.practiceSkill
    if (base === null) {
      return LIVE_SKILL + this.rng.range(-LIVE_SKILL_SPREAD, LIVE_SKILL_SPREAD)
    }
    const sharp = base >= SHARP_FROM && this.rng.next() < SHARP_ODDS ? SHARP_BONUS : 0
    return Math.min(1, Math.max(0, base + sharp + this.rng.range(-0.05, 0.05)))
  }

  private brain(id: number): BotBrain {
    let b = this.brains.get(id)
    if (!b) {
      const skill = this.rollSkill()
      b = {
        skill,
        aim: aimFor(skill),
        aimRad: 0,
        wander: 0,
        wanderGoal: 0,
        wanderAt: 0,
        fireAt: 0,
        burstLeft: 0,
        visible: false,
        lostAt: 0,
        lastSeenX: 0,
        lastSeenZ: 0,
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

  /** Last tick's kills, for the streak ramp (the sim clears events at the start of the next step). */
  private readStreaks(w: World): void {
    for (const ev of w.events) {
      if (ev.type === 'kill') {
        this.streak.set(ev.victim, 0)
        if (ev.killer !== NONE && ev.killer !== ev.victim) {
          this.streak.set(ev.killer, (this.streak.get(ev.killer) ?? 0) + 1)
        }
      }
    }
  }

  /** One input frame for every bot in the world this tick. */
  frames(w: World, out: (InputFrame | null)[]): void {
    if (this.practiceSkill !== null) {
      this.readStreaks(w)
    }
    for (const p of activePlayers(w)) {
      if (p.bot) {
        out[p.id] = this.think(w, p)
      }
    }
  }

  private bankAt(): number {
    return this.practiceSkill === null ? BANK_AT : PRACTICE_BANK_AT
  }

  private pickGoal(w: World, p: Player): { x: number; z: number } {
    const host = this.rally === NONE ? null : w.players[this.rally]
    if (host?.alive) {
      return { x: host.x + this.rng.range(-5, 5), z: host.z + this.rng.range(-3.5, 3.5) }
    }
    if (p.carried >= this.bankAt()) {
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

  /** Swing the bot's hand toward `q` at its own pace, and let it wander. Returns how far off it is. */
  private track(w: World, b: BotBrain, q: Player, toward: { dx: number; dz: number }): number {
    let diff = Math.atan2(toward.dz, toward.dx) - b.aimRad
    diff -= Math.round(diff / (Math.PI * 2)) * Math.PI * 2
    const turn = b.aim.turnRad
    b.aimRad += Math.max(-turn, Math.min(turn, diff))
    if (w.tick >= b.wanderAt) {
      // a fresh slip of the hand every half second or so (a rough bell curve)
      const g = (this.rng.next() + this.rng.next() + this.rng.next() - 1.5) * 2
      b.wanderGoal = g * b.aim.wanderRad * (q.moving ? 1.3 : 1)
      b.wanderAt = w.tick + this.rng.int(6, 14)
    }
    b.wander += (b.wanderGoal - b.wander) * 0.35
    return Math.abs(diff)
  }

  /** Pull the trigger this tick? Reaction first, then bursts at the bot's cadence, on target only. */
  private trigger(w: World, b: BotBrain, offBy: number): boolean {
    if (!b.visible || w.tick < b.fireAt || offBy > 0.3) {
      return false
    }
    const a = b.aim
    b.burstLeft--
    if (b.burstLeft <= 0) {
      b.burstLeft = a.burst
      b.fireAt = w.tick + a.pauseTicks + this.rng.int(0, 6)
    } else {
      b.fireAt = w.tick + a.fireTicks + this.rng.int(0, 4)
    }
    return true
  }

  private fight({ w, p, b, q, f }: Engagement): void {
    // a hidden target is hunted where it was last seen, not shot through the wall
    let dx = (b.visible ? q.x : b.lastSeenX) - p.x
    let dz = (b.visible ? q.z : b.lastSeenZ) - p.z
    if (dx * dx + dz * dz < POINT_BLANK_M ** 2) {
      // On top of each other (a shared goal, a shared doorway): with no direction between them
      // they'd stand and trade shots forever. Each backs off its own way (by id) and circles.
      const a = (p.id * 2.399_963) % (Math.PI * 2)
      dx = Math.cos(a) * POINT_BLANK_M
      dz = Math.sin(a) * POINT_BLANK_M
    }
    const d = Math.sqrt(dx * dx + dz * dz) || 1
    const offBy = this.track(w, b, q, { dx: q.x - p.x, dz: q.z - p.z })
    f.aim = radiansToAim(b.aimRad + b.wander)
    // Strafe around the target, closing to ~10 m (straight at the spot it was last seen).
    if (this.rng.next() < 0.03) {
      b.strafe = -b.strafe
    }
    let approach = 0
    if (!b.visible || d > 12) {
      approach = 1
    } else if (d <= POINT_BLANK_M) {
      approach = -1
    } else if (d < 7) {
      approach = -0.6
    }
    const side = b.visible ? 0.8 : 0
    f.moveX = Math.round(((dx / d) * approach - (dz / d) * b.strafe * side) * 100)
    f.moveZ = Math.round(((dz / d) * approach + (dx / d) * b.strafe * side) * 100)
    f.buttons = this.trigger(w, b, offBy) ? BTN_FIRE : 0
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
    if (b.visible && p.dynamite > 0 && d > 5 && d < 10 && this.rng.next() < 0.1) {
      f.buttons |= BTN_THROW
    }
    if (p.hp < 50 && this.rng.next() < 0.04) {
      f.buttons |= BTN_ROLL
    }
  }

  /** Bots fighting each human right now (not counting `self`). */
  private packs(w: World, self: number): Map<number, number> {
    const out = new Map<number, number>()
    for (const [id, b] of this.brains) {
      const q = b.target >= 0 ? w.players[b.target] : null
      if (id !== self && q && !q.bot && q.alive) {
        out.set(q.id, (out.get(q.id) ?? 0) + 1)
      }
    }
    return out
  }

  /**
   * Every few ticks: keep the target while it's in sight; if it ducked behind cover, remember where
   * for a while (and hold fire); else pick the nearest one in sight. A new target costs the bot its
   * reaction time; one that reappears from cover costs half of it.
   */
  private scan(w: World, p: Player, b: BotBrain): void {
    b.scanAt = w.tick + SCAN_TICKS
    const old = b.target >= 0 ? w.players[b.target] : null
    const keep = (b.aim.range + 3) ** 2
    if (old?.alive && old.showdown < 0 && dist2(p.x, p.z, old.x, old.z) < keep) {
      if (hasLineOfSight(w.grid, p, old)) {
        if (!b.visible) {
          b.visible = true
          b.fireAt = Math.max(b.fireAt, w.tick + (b.aim.reactTicks >> 1))
        }
        b.lastSeenX = old.x
        b.lastSeenZ = old.z
        return
      }
      if (b.visible) {
        b.visible = false
        b.lostAt = w.tick
      }
      if (w.tick - b.lostAt < b.aim.memoryTicks) {
        return
      }
    }
    const grace = this.practiceSkill === null ? SPAWN_GRACE_LIVE : SPAWN_GRACE_PRACTICE
    const q = pickTarget({ w, p, b, pack: this.packs(w, p.id), grace, spare: this.rally })
    b.target = q ? q.id : -1
    b.visible = q !== null
    if (!q) {
      return
    }
    b.lastSeenX = q.x
    b.lastSeenZ = q.z
    b.burstLeft = b.aim.burst
    b.fireAt = w.tick + b.aim.reactTicks + this.rng.int(0, 3)
    if (old?.id !== q.id) {
      // the hand starts from wherever the bot was looking
      b.aimRad = aimRadians(p.aim)
    }
    this.sharpen(b, q)
  }

  /** Practice: against a human on a streak the bot sharpens (its own skill against anyone else). */
  private sharpen(b: BotBrain, q: Player): void {
    if (this.practiceSkill === null) {
      return
    }
    const boost = q.bot ? 0 : Math.min(STREAK_CAP, STREAK_STEP * (this.streak.get(q.id) ?? 0))
    b.aim = aimFor(b.skill + boost)
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
      f.buttons = 0
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
      if (!p.alive) {
        b.target = -1
        b.visible = false
      }
      return f
    }
    if (p.calledBy !== NONE) {
      // Accept most call-outs: press, release, press.
      f.buttons = (w.tick + p.id) % 2 === 0 && p.id % 4 !== 0 ? BTN_CALLOUT : 0
      return f
    }
    if (p.channel) {
      // Stand still while banking or opening a box.
      return f
    }
    if (w.tick >= b.scanAt) {
      this.scan(w, p, b)
    }
    const q = b.target >= 0 ? w.players[b.target] : null
    const host = this.rally === NONE ? null : w.players[this.rally]
    const straying = host?.alive === true && dist2(p.x, p.z, host.x, host.z) > RALLY_LEASH ** 2
    if (q?.alive && p.carried < this.bankAt() * 2 && !straying) {
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
