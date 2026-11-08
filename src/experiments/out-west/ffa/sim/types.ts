/** Frontier sim state. Plain data, so the client can mirror the parts it predicts. */

/** One 20 Hz input frame, as decoded from the wire (see `contract/town.ts`). */
export interface InputFrame {
  seq: number
  /** −127..127; the sim normalises the vector, so a hacked magnitude buys nothing. */
  moveX: number
  moveZ: number
  /** u16 turns: 0 = +x, increasing toward +z. */
  aim: number
  buttons: number
  /** Full server tick (+ fraction) of the remote-entity time the client rendered. */
  viewTime: number
  /** Aim pitch, ±127 = ±90° (wire v6; used for 3D hits since v7). */
  pitch?: number
}

/** The movement subset of a player: what client prediction replays. */
export interface MoveState {
  x: number
  z: number
  /** Feet height above the street, metres (0 at street level, a porch roof's top on a deck). */
  y: number
  /** Walking level: 0 is the street, `n` is `ROOF_WALKS[n - 1]`. */
  roof: number
  /** Ticks left on a committed ladder climb, the walk being climbed and the direction (+1/-1). */
  climbTicks: number
  climbDeck: number
  climbDir: number
  /** Ticks left on a committed step-off, the fall's duration, and its start/end points. */
  fallTicks: number
  fallTotal: number
  fallFromX: number
  fallFromZ: number
  fallFromY: number
  fallToX: number
  fallToY: number
  fallToZ: number
  rollTicks: number
  rollCooldown: number
  rollDirX: number
  rollDirZ: number
  /** Ticks left of a vault (`vaultStep` > 0) or a hop (`vaultStep` 0). */
  jumpTicks: number
  jumpCooldown: number
  /** Vault travel per tick (m, whole centimetres) and direction (u16 turns, as on the wire). */
  vaultStep: number
  vaultAim: number
  /** Sprinting on the last tick (wire v5). */
  sprinting: boolean
  /** Ticks the sprint stays off after a trigger pull (renewed while the trigger is held). */
  sprintLock: number
  /** Ticks until the gun is up after a sprint (the sprint-to-fire delay). */
  sprintOut: number
  /** Ticks left of a slide, its cooldown, and its heading (u16 turns, as on the wire). */
  slideTicks: number
  slideCooldown: number
  slideAim: number
  /** Velocity in the air (m per tick, whole centimetres): kept from take-off, steered a little. */
  airX: number
  airZ: number
  /** Vertical velocity, m/s (positive up). */
  vy: number
  /** Feet are on a surface this tick. */
  grounded: boolean
  /** Height of the surface under the feet, metres. */
  support: number
  /** Highest point since leaving the ground, for fall damage. */
  airPeakY: number
  /** A committed ledge pull-up. */
  mantleTicks: number
  mantleFromX: number
  mantleFromY: number
  mantleFromZ: number
  mantleToX: number
  mantleToY: number
  mantleToZ: number
  /** Damage from the last landing, for the world to apply (0 when none). */
  fallDamage: number
}

export interface Channel {
  kind: number
  ticks: number
  total: number
  /** The bank/stage zone that started it; the channel survives small moves inside it. */
  zoneId?: string
}

export interface DamageRecord {
  from: number
  amount: number
  tick: number
}

export interface PlayerStats {
  kills: number
  deaths: number
  deadEyeKills: number
  shots: number
  hits: number
  banked: number
  showdownWins: number
  /** XP earned and not yet flushed to the ledger (excludes bank XP, which rides on deposits). */
  xp: number
  /** XP from banking this session (settled with each deposit). */
  bankXp: number
  /** Aim snaps over 90° in one tick right before a hit (aimbot heuristic). */
  snapHits: number
}

export interface Player extends MoveState {
  id: number
  accountId: string
  name: string
  level: number
  prestige: number
  /**
   * The equipped saddlebag cosmetic, as an index into `BAG_STYLES` (contract/town.ts): the look of
   * the bag this player drops. Cosmetic only: every style holds, drops and is picked up the same.
   */
  saddlebag: number
  bot: boolean
  aim: number
  prevAim: number
  moving: boolean
  /** Aim pitch as the client last sent it (±127 = ±90°; authoritative). */
  pitch: number
  /** Held this tick: crouched, on the sights (the stance bits remote riders see). */
  crouched: boolean
  ads: boolean
  /** Spread added by recent shots (degrees), settling every tick. */
  bloom: number
  /** A trigger pull waiting for the gun to come up out of a sprint. */
  fireQueued: boolean
  alive: boolean
  hp: number
  lastDamageTick: number
  /** Tick the player respawns (while dead). */
  respawnTick: number
  spawnTick: number
  protectUntil: number
  ammo: number
  reloadTicks: number
  /** Remaining fire cooldown in ms (carried across ticks so the rate averages 280 ms). */
  fireCooldownMs: number
  lastFireTick: number
  /** Tick the Dead-Eye reticle started closing, or −1. */
  deadEyeStart: number
  hatless: boolean
  /** `WEAPON_*` in hand; pickup weapons run on `weaponRounds`, the revolver on `ammo`. */
  weapon: number
  weaponRounds: number
  /** Sticks of dynamite held (0 or 1). */
  dynamite: number
  carried: number
  channel: Channel | null
  lastButtons: number
  /** Showdown id, or −1. */
  showdown: number
  calloutCooldownUntil: number
  /** Pending call-out against this player: challenger id and expiry tick. */
  calledBy: number
  calledUntil: number
  damage: DamageRecord[]
  /** Victim account id → kill ticks inside the farm window. */
  kills: Map<string, number[]>
  stats: PlayerStats
  depositSeq: number
  /** Disconnected and standing still until this tick (−1 when connected). */
  lingerUntil: number
  /** True once the player has left: the lobby removes them after the tick. */
  gone: boolean
  /** Last input seq consumed (echoed in snapshots for reconciliation). */
  lastSeq: number
}

export interface Bag {
  id: number
  x: number
  z: number
  amount: number
  /** The dropper's saddlebag style (index into `BAG_STYLES`). Cosmetic only. */
  style: number
  /** Killer's player id with first claim, and until when. */
  exclusiveFor: number
  exclusiveUntil: number
  expiresAt: number
}

export interface PickupState {
  /** Index into the layout's `pickups`. */
  spot: number
  /** Tick it's available again (0 = available now). */
  availableAt: number
}

export interface Fuse {
  by: number
  x: number
  z: number
  explodeAt: number
}

export interface Strongbox {
  spot: number
  value: number
  /** Player opening it, or −1. */
  openedBy: number
  progress: number
}

export interface Showdown {
  id: number
  a: number
  b: number
  cx: number
  cz: number
  startTick: number
  /** Tick the bell rings. */
  callTick: number
  fakeTicks: number[]
  phase: 'wait' | 'called' | 'done'
}

/** A deposit for the lobby to settle in D1 (idempotency key from accountId + seq). */
export interface Deposit {
  playerId: number
  accountId: string
  seq: number
  amount: number
  commission: number
  xp: number
  bot: boolean
}

/** World-space point on an authoritative shot, metres. */
export interface ShotPoint {
  x: number
  y: number
  z: number
}

export type SimEvent =
  | {
      type: 'shot'
      /** Monotonic confirmed shot count within this rider's current incarnation. */
      shotId: number
      spawnTick: number
      shooter: number
      aim: number
      range: number
      target: number
      flags: number
      x: number
      z: number
      /** Height of the impact, decimetres (legacy range metadata). */
      y: number
      origin: ShotPoint
      end: ShotPoint
      /** Every pellet's actual endpoint; empty for a single bullet. */
      pellets: ShotPoint[]
    }
  | { type: 'damage'; victim: number; attacker: number; amount: number; hp: number }
  | { type: 'kill'; victim: number; killer: number; flags: number; bounty: number }
  | { type: 'bag_drop'; bag: Bag }
  | { type: 'bag_gone'; bagId: number; by: number }
  | { type: 'deposit'; player: number; amount: number; commission: number }
  | { type: 'respawn'; player: number }
  | { type: 'strongbox_spawn'; spot: number; value: number }
  | { type: 'strongbox_open'; spot: number; by: number; value: number }
  | { type: 'callout'; challenger: number; target: number }
  | { type: 'showdown_start'; showdown: Showdown }
  | { type: 'showdown_fake'; id: number; cue: number }
  | { type: 'showdown_call'; id: number }
  | { type: 'showdown_end'; id: number; winner: number; outcome: number; winnerMs: number }
  | { type: 'channel_cancel'; player: number; kind: number }
  | { type: 'hat_off'; player: number }
  | { type: 'left'; player: number }
  | { type: 'pickup_taken'; spot: number; player: number }
  | { type: 'pickup_ready'; spot: number }
  | { type: 'glass_break'; window: number }
  | { type: 'dynamite_thrown'; player: number; x: number; z: number; fuseTicks: number }
  | { type: 'explosion'; by: number; x: number; z: number }

export function newStats(): PlayerStats {
  return {
    kills: 0,
    deaths: 0,
    deadEyeKills: 0,
    shots: 0,
    hits: 0,
    banked: 0,
    showdownWins: 0,
    xp: 0,
    bankXp: 0,
    snapHits: 0,
  }
}

/**
 * A complete movement state standing at rest at (x, z). Tests build their fixtures from this so a
 * new `MoveState` field is filled once, not three times; the live sim builds its own in
 * `state.ts` (`newPlayer`) with the same defaults.
 */
export function makeMoveState(x: number, z: number): MoveState {
  return {
    x,
    z,
    y: 0,
    roof: 0,
    climbTicks: 0,
    climbDeck: 0,
    climbDir: 0,
    fallTicks: 0,
    fallTotal: 0,
    fallFromX: 0,
    fallFromZ: 0,
    fallFromY: 0,
    fallToX: 0,
    fallToY: 0,
    fallToZ: 0,
    rollTicks: 0,
    rollCooldown: 0,
    rollDirX: 0,
    rollDirZ: 0,
    jumpTicks: 0,
    jumpCooldown: 0,
    vaultStep: 0,
    vaultAim: 0,
    sprinting: false,
    sprintLock: 0,
    sprintOut: 0,
    slideTicks: 0,
    slideCooldown: 0,
    slideAim: 0,
    airX: 0,
    airZ: 0,
    vy: 0,
    grounded: true,
    support: 0,
    airPeakY: 0,
    mantleTicks: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleFromZ: 0,
    mantleToX: 0,
    mantleToY: 0,
    mantleToZ: 0,
    fallDamage: 0,
  }
}
