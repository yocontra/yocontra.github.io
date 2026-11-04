/** The world record every sim module operates on, plus small shared helpers. */
import { CHANNEL_NONE, NONE, WEAPON_REVOLVER } from '../../contract/town.ts'
import { HISTORY_TICKS, MAX_PLAYERS, REVOLVER_ROUNDS } from './constants.ts'
import { buildGrid, type Grid, TOWN, type TownLayout } from './layout.ts'
import { Rng } from './rng.ts'
import {
  type Bag,
  type Deposit,
  type Fuse,
  newStats,
  type PickupState,
  type Player,
  type Showdown,
  type SimEvent,
  type Strongbox,
} from './types.ts'

export const HIST_ALIVE = 1
export const HIST_IFRAMES = 2
export const HIST_PROTECTED = 4
export const HIST_SHOWDOWN = 8
/** Set for every occupied slot, so a zero flags word means "nobody here". */
export const HIST_PRESENT = 16
/** x, z, flags per player per history tick. */
const HIST_STRIDE = 3

export interface World {
  tick: number
  seed: number
  rng: Rng
  layout: TownLayout
  grid: Grid
  players: (Player | null)[]
  bags: Bag[]
  nextBagId: number
  strongbox: Strongbox | null
  nextStrongboxTick: number
  pickups: PickupState[]
  fuses: Fuse[]
  showdowns: Map<number, Showdown>
  nextShowdownId: number
  /**
   * Player pairs that may never face each other in a call-out (one of them blocks the other),
   * as {@link pairKey}s. The lobby keeps it current as players join and leave.
   */
  noDuel: Set<number>
  mostWanted: number
  /** Events produced by the current tick (cleared at the start of each step). */
  events: SimEvent[]
  /** Deposits produced by recent ticks; the lobby drains this. */
  deposits: Deposit[]
  /** Ring buffer of positions for lag compensation: [tick % HISTORY][player][x, z, flags]. */
  history: Float64Array
  /** Economy audit, in dollars since the world started. */
  minted: number
  burned: number
  /**
   * The practice town (the client's loopback lobby, never the Lobby DO): bag magnet, bots carry a
   * few dollars, bot kills pay practice XP, a first-bank bonus. Its money reaches no wallet.
   */
  practice: boolean
}

/** An order-independent key for a pair of player slots. */
export const pairKey = (a: number, b: number): number => Math.min(a, b) * 256 + Math.max(a, b)

export interface WorldOptions {
  seed?: number
  layout?: TownLayout
  grid?: Grid
  practice?: boolean
}

export function createWorld(options: WorldOptions = {}): World {
  const layout = options.layout ?? TOWN
  const seed = (options.seed ?? 1) >>> 0
  return {
    tick: 0,
    seed,
    rng: new Rng(seed),
    layout,
    grid: options.grid ?? buildGrid(layout),
    players: Array.from({ length: MAX_PLAYERS }, () => null),
    bags: [],
    nextBagId: 1,
    strongbox: null,
    nextStrongboxTick: 0,
    pickups: layout.pickups.map((_, spot) => ({ spot, availableAt: 0 })),
    fuses: [],
    showdowns: new Map(),
    nextShowdownId: 1,
    noDuel: new Set(),
    mostWanted: NONE,
    events: [],
    deposits: [],
    history: new Float64Array(HISTORY_TICKS * MAX_PLAYERS * HIST_STRIDE),
    minted: 0,
    burned: 0,
    practice: options.practice === true,
  }
}

export interface PlayerInit {
  accountId: string
  name: string
  level: number
  prestige: number
  bot: boolean
  /** Index into `BAG_STYLES` (defaults to the Plain Sack). */
  saddlebag?: number
}

export function newPlayer(id: number, init: PlayerInit): Player {
  return {
    id,
    ...init,
    saddlebag: init.saddlebag ?? 0,
    x: 0,
    z: 0,
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
    aim: 0,
    prevAim: 0,
    moving: false,
    pitch: 0,
    crouched: false,
    ads: false,
    bloom: 0,
    fireQueued: false,
    alive: false,
    hp: 0,
    lastDamageTick: -1_000_000,
    respawnTick: 0,
    spawnTick: 0,
    protectUntil: 0,
    ammo: REVOLVER_ROUNDS,
    reloadTicks: 0,
    fireCooldownMs: 0,
    lastFireTick: -1_000_000,
    deadEyeStart: -1,
    hatless: false,
    weapon: WEAPON_REVOLVER,
    weaponRounds: 0,
    dynamite: 0,
    carried: 0,
    channel: null,
    lastButtons: 0,
    showdown: -1,
    calloutCooldownUntil: 0,
    calledBy: NONE,
    calledUntil: 0,
    damage: [],
    kills: new Map(),
    stats: newStats(),
    depositSeq: 0,
    lingerUntil: -1,
    gone: false,
    lastSeq: 0,
  }
}

export function* activePlayers(w: World): Generator<Player> {
  for (const p of w.players) {
    if (p && !p.gone) {
      yield p
    }
  }
}

export const humanCount = (w: World): number => {
  let n = 0
  for (const p of activePlayers(w)) {
    if (!p.bot) {
      n++
    }
  }
  return n
}

export const channelKind = (p: Player): number => p.channel?.kind ?? CHANNEL_NONE

export const isProtected = (w: World, p: Player): boolean => w.tick < p.protectUntil

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  return (ax - bx) ** 2 + (az - bz) ** 2
}

function histIndex(tick: number, id: number): number {
  return ((tick % HISTORY_TICKS) * MAX_PLAYERS + id) * HIST_STRIDE
}

export function recordHistory(w: World, flagsFor: (p: Player) => number): void {
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const p = w.players[id]
    const i = histIndex(w.tick, id)
    if (p && !p.gone) {
      w.history[i] = p.x
      w.history[i + 1] = p.z
      w.history[i + 2] = flagsFor(p)
    } else {
      w.history[i + 2] = 0
    }
  }
}

export interface PastPose {
  x: number
  z: number
  flags: number
}

/**
 * Where player `id` was at fractional tick `time` (interpolated between recorded ticks). `time` must
 * lie within the history window; callers clamp it. Flags come from the earlier tick.
 */
export function poseAt(w: World, id: number, time: number): PastPose | null {
  const t0 = Math.floor(time)
  const frac = time - t0
  const i0 = histIndex(t0, id)
  const flags = w.history[i0 + 2] ?? 0
  if (flags === 0) {
    return null
  }
  const x0 = w.history[i0] ?? 0
  const z0 = w.history[i0 + 1] ?? 0
  if (frac <= 0 || t0 + 1 > w.tick) {
    return { x: x0, z: z0, flags }
  }
  const i1 = histIndex(t0 + 1, id)
  if ((w.history[i1 + 2] ?? 0) === 0) {
    return { x: x0, z: z0, flags }
  }
  return {
    x: x0 + ((w.history[i1] ?? x0) - x0) * frac,
    z: z0 + ((w.history[i1 + 1] ?? z0) - z0) * frac,
    flags,
  }
}
