/**
 * The fixed-step world: one `step()` per 20 Hz tick, given one input frame per player. Deterministic
 * for a given seed and input sequence. The lobby DO runs it authoritatively; the client may run it
 * for prediction of its own movement (`move.ts`) only.
 */

import { BTN_AIM, BTN_CROUCH, NONE, WEAPON_REVOLVER } from '../../contract/town.ts'
import { canFire, fire, trigger, updateWeapon } from './combat.ts'
import {
  HOLSTER_TICKS,
  LINGER_TICKS,
  MAX_HP,
  MAX_PLAYERS,
  MOST_WANTED_REFRESH_TICKS,
  REGEN_DELAY_TICKS,
  REGEN_PER_TICK,
  REVOLVER_ROUNDS,
  SPAWN_LOS_DIST,
  SPAWN_MIN_ENEMY_DIST,
  SPAWN_PROTECT_TICKS,
} from './constants.ts'
import { applyFallDamage, spillCarry } from './death.ts'
import { hasLineOfSight, type SpawnPoint } from './layout.ts'
import {
  progressChannel,
  refreshMostWanted,
  startChannel,
  updateBags,
  updateStrongbox,
} from './money.ts'
import { inIframes, resetVertical, stopMoves } from './move.ts'
import {
  clearPickups,
  firePickupWeapon,
  maybeThrow,
  updateFuses,
  updatePickups,
} from './pickups.ts'
import { handleCallout, updateShowdowns } from './showdown.ts'
import {
  activePlayers,
  dist2,
  HIST_ALIVE,
  HIST_CROUCHED,
  HIST_IFRAMES,
  HIST_PRESENT,
  HIST_PROTECTED,
  HIST_SHOWDOWN,
  isProtected,
  newPlayer,
  type PlayerInit,
  recordHistory,
  type World,
} from './state.ts'
import type { InputFrame, Player } from './types.ts'

const IDLE_FRAME: InputFrame = { seq: 0, moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTime: 0 }

interface SpawnScore {
  index: number
  nearest: number
  seen: boolean
}

function scoreSpawn(w: World, sp: SpawnPoint, index: number, self: Player): SpawnScore {
  let nearest = Number.POSITIVE_INFINITY
  for (const q of activePlayers(w)) {
    if (q !== self && q.alive) {
      nearest = Math.min(nearest, Math.sqrt(dist2(sp.x, sp.z, q.x, q.z)))
    }
  }
  return { index, nearest, seen: false }
}

/** At most eight native rays per shortlisted spawn; excess nearby threats are conservative. */
function spawnSeen(w: World, sp: SpawnPoint, self: Player): boolean {
  const threats = [...activePlayers(w)]
    .filter((q) => q !== self && q.alive && dist2(sp.x, sp.z, q.x, q.z) <= SPAWN_LOS_DIST ** 2)
    .toSorted((a, b) => dist2(sp.x, sp.z, a.x, a.z) - dist2(sp.x, sp.z, b.x, b.z))
  if (threats.length > 8) {
    return true
  }
  for (const q of threats) {
    if (!w.castWorld) {
      if (hasLineOfSight(w.grid, sp, q)) {
        return true
      }
      continue
    }
    const dx = q.x - sp.x
    const dy = q.y
    const dz = q.z - sp.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance < 0.01) {
      return true
    }
    const hit = w.castWorld({
      ox: sp.x,
      oy: 1.62,
      oz: sp.z,
      dx: dx / distance,
      dy: dy / distance,
      dz: dz / distance,
      maxT: distance,
    })
    if (hit === null || hit >= distance - 0.05) {
      return true
    }
  }
  return false
}

/** Never spawn this close (m) to a living rider: two riders on one point lock up. */
const SPAWN_CLEAR_M = 4

/**
 * The safest spawn: prefer points ≥25 m from every enemy with no enemy line of sight within 35 m;
 * pick at random among the best few so spawns don't become predictable. A point with a rider
 * standing on it (within 4 m) is never picked while any other is clear.
 */
export function chooseSpawn(w: World, self: Player): SpawnPoint {
  const spawns = w.layout.spawns
  const all = spawns.map((sp, i) => scoreSpawn(w, sp, i, self))
  const clear = all.filter((s) => s.nearest >= SPAWN_CLEAR_M)
  const scored = (clear.length > 0 ? clear : all)
    .toSorted((a, b) => b.nearest - a.nearest || a.index - b.index)
    .slice(0, 12)
  for (const candidate of scored) {
    const spawn = spawns[candidate.index]
    if (spawn) {
      candidate.seen = spawnSeen(w, spawn, self)
    }
  }
  const safe = scored.filter((s) => s.nearest >= SPAWN_MIN_ENEMY_DIST && !s.seen)
  const pool = (safe.length > 0 ? safe : scored).toSorted(
    (a, b) => b.nearest - a.nearest || a.index - b.index,
  )
  const pick = pool[w.rng.int(0, Math.min(3, pool.length) - 1)] ?? pool[0]
  return spawns[pick?.index ?? 0] ?? { x: w.layout.size / 2, z: w.layout.size / 2, interior: false }
}

export function spawnPlayer(w: World, p: Player): void {
  const sp = chooseSpawn(w, p)
  p.x = sp.x
  p.z = sp.z
  p.alive = true
  p.hp = MAX_HP
  p.spawnTick = w.tick
  p.protectUntil = w.tick + SPAWN_PROTECT_TICKS
  p.ammo = REVOLVER_ROUNDS
  p.reloadTicks = 0
  stopMoves(p)
  resetVertical(p)
  p.jumpCooldown = 0
  p.slideCooldown = 0
  p.sprintLock = 0
  p.bloom = 0
  p.fireQueued = false
  p.fireCooldownMs = 0
  p.lastFireTick = w.tick - HOLSTER_TICKS
  p.deadEyeStart = -1
  p.hatless = false
  clearPickups(p)
  p.lastDamageTick = -1_000_000
  w.events.push({ type: 'respawn', player: p.id })
}

/** Add a player in the first free slot and spawn them. Returns the id, or −1 if full. */
export function addPlayer(w: World, init: PlayerInit): number {
  const id = w.players.indexOf(null)
  if (id < 0 || id >= MAX_PLAYERS) {
    return -1
  }
  const p = newPlayer(id, init)
  w.players[id] = p
  spawnPlayer(w, p)
  return id
}

/** Free the slot of a player who has gone (after the lobby has settled them). */
export function removePlayer(w: World, id: number): void {
  w.players[id] = null
  if (w.mostWanted === id) {
    w.mostWanted = NONE
  }
}

/** Socket dropped: the avatar stands still and vulnerable for 10 s, then its carry drops. */
export function disconnectPlayer(w: World, p: Player): void {
  if (p.lingerUntil < 0) {
    p.lingerUntil = w.tick + LINGER_TICKS
    p.channel = null
  }
}

export function reconnectPlayer(p: Player): void {
  p.lingerUntil = -1
}

export function historyFlags(w: World, p: Player): number {
  if (!p.alive) {
    return HIST_PRESENT
  }
  let f = HIST_PRESENT | HIST_ALIVE
  if (inIframes(p)) {
    f |= HIST_IFRAMES
  }
  if (isProtected(w, p)) {
    f |= HIST_PROTECTED
  }
  if (p.showdown >= 0) {
    f |= HIST_SHOWDOWN
  }
  if (p.crouched) {
    f |= HIST_CROUCHED
  }
  return f
}

function lifecycle(w: World, p: Player): void {
  if (p.lingerUntil >= 0 && w.tick >= p.lingerUntil) {
    spillCarry(w, p, NONE, false)
    p.gone = true
    w.events.push({ type: 'left', player: p.id })
    return
  }
  if (!p.alive) {
    if (w.tick >= p.respawnTick) {
      if (p.lingerUntil >= 0) {
        p.gone = true
        w.events.push({ type: 'left', player: p.id })
      } else {
        spawnPlayer(w, p)
      }
    }
    return
  }
  if (p.hp < MAX_HP && w.tick - p.lastDamageTick >= REGEN_DELAY_TICKS) {
    p.hp = Math.min(MAX_HP, p.hp + REGEN_PER_TICK)
  }
}

function act(w: World, p: Player, f: InputFrame, aliveAtStart: boolean): void {
  if (p.lingerUntil >= 0) {
    return
  }
  updateWeapon(w, p, f.buttons)
  if (canFire(p, trigger(p, f.buttons, aliveAtStart), aliveAtStart)) {
    if (p.weapon === WEAPON_REVOLVER) {
      fire(w, p, f.aim, f.viewTime)
    } else {
      firePickupWeapon(w, p, f.aim, f.viewTime)
    }
  }
  maybeThrow(w, p, f.buttons, f.aim)
  if (!p.alive) {
    return
  }
  if (!handleCallout(w, p, f.buttons)) {
    startChannel(w, p, f.buttons)
  }
}

/**
 * Advance one tick. `frames[id]` is that player's input for this tick (null: repeat nothing).
 * Events for the tick are in `w.events` afterwards.
 */
export function step(w: World, frames: readonly (InputFrame | null | undefined)[]): void {
  w.events = []
  const frameOf = (id: number): InputFrame => frames[id] ?? IDLE_FRAME
  const players = [...activePlayers(w)]
  const aliveAtStart = players.map((p) => p.alive)
  w.movePlayers?.(frames)
  for (const p of players) {
    const f = frameOf(p.id)
    p.prevAim = p.aim
    if (p.lingerUntil < 0) {
      p.aim = f.aim
    }
    p.pitch = f.pitch ?? 0
    if (!w.movePlayers) {
      p.crouched = p.alive && (f.buttons & BTN_CROUCH) !== 0
    }
    p.ads = p.alive && (f.buttons & BTN_AIM) !== 0
    // Domain-only fixtures are stationary; shipping worlds supply the native engine phase.
    if (!w.movePlayers) {
      p.moving = false
    }
    if (p.fallDamage > 0 && p.alive) {
      applyFallDamage(w, p, p.fallDamage)
      p.fallDamage = 0
    }
  }
  // Every shot this tick sees the same start-of-tick liveness, so trades are possible.
  for (const [i, p] of players.entries()) {
    act(w, p, frameOf(p.id), aliveAtStart[i] === true)
  }
  updateShowdowns(w, (id) => frameOf(id).buttons)
  for (const p of players) {
    progressChannel(w, p)
  }
  updateBags(w)
  updatePickups(w)
  updateFuses(w)
  updateStrongbox(w)
  if (w.tick % MOST_WANTED_REFRESH_TICKS === 0) {
    refreshMostWanted(w)
  }
  for (const p of players) {
    if (!p.gone) {
      lifecycle(w, p)
    }
    const f = frameOf(p.id)
    p.lastButtons = f.buttons
    if (frames[p.id]) {
      p.lastSeq = f.seq
    }
  }
  recordHistory(w, (p) => historyFlags(w, p))
  w.tick++
}
