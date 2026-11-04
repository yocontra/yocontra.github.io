/**
 * Map pickups (§3.2): shotgun, rifle and dynamite at fixed spots from the layout, respawning 45 s
 * after they're taken. Equal access, nothing carried between lives. Server-authoritative like
 * everything else in the sim.
 */
import {
  BTN_THROW,
  NONE,
  SHOT_HIT,
  SHOT_RANGE_UNIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  SHOT_WALL,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import { pressed, rewindTime, spreadFor, strike, traceTargets } from './combat.ts'
import {
  DYNAMITE_DAMAGE,
  DYNAMITE_FUSE_TICKS,
  DYNAMITE_RADIUS,
  DYNAMITE_THROW_RANGE,
  PICKUP_RADIUS,
  PICKUP_RESPAWN_TICKS,
  RIFLE_DAMAGE,
  RIFLE_FIRE_MS,
  RIFLE_RANGE,
  RIFLE_ROUNDS,
  SHOTGUN_FIRE_MS,
  SHOTGUN_PELLET_DAMAGE,
  SHOTGUN_PELLETS,
  SHOTGUN_RANGE,
  SHOTGUN_SHELLS,
  TICK_MS,
} from './constants.ts'
import { applyDamage } from './death.ts'
import { BLOCK_SHOT, BLOCK_SIGHT, hasLineOfSight, rayGrid } from './layout.ts'
import { aimRadians, inIframes, quantize, radiansToAim, vaulting } from './move.ts'
import { hashSigned } from './rng.ts'
import { bloomAfterShot } from './spread.ts'
import { activePlayers, dist2, isProtected, type World } from './state.ts'
import type { Player } from './types.ts'

const DEG = Math.PI / 180

/** Give `p` what's at a spot. False if they can't take it (already holding dynamite). */
function take(p: Player, kind: string): boolean {
  if (kind === 'dynamite') {
    if (p.dynamite > 0) {
      return false
    }
    p.dynamite = 1
    return true
  }
  const rifle = kind === 'rifle'
  p.weapon = rifle ? WEAPON_RIFLE : WEAPON_SHOTGUN
  p.weaponRounds = rifle ? RIFLE_ROUNDS : SHOTGUN_SHELLS
  p.deadEyeStart = -1
  return true
}

/** The first eligible player standing on a spot takes it. */
function claim(
  w: World,
  index: number,
  { x, z, kind }: { x: number; z: number; kind: string },
): number {
  for (const p of activePlayers(w)) {
    const free = p.alive && p.lingerUntil < 0 && p.showdown < 0 && p.roof === 0
    if (free && dist2(p.x, p.z, x, z) <= PICKUP_RADIUS ** 2 && take(p, kind)) {
      w.events.push({ type: 'pickup_taken', spot: index, player: p.id })
      return p.id
    }
  }
  return -1
}

/** Walk over an available spot to take it. Spawn-protected players can take weapons. */
export function updatePickups(w: World): void {
  for (const pk of w.pickups) {
    const spot = w.layout.pickups[pk.spot]
    if (!spot) {
      continue
    }
    if (pk.availableAt === 0) {
      if (claim(w, pk.spot, spot) >= 0) {
        pk.availableAt = w.tick + PICKUP_RESPAWN_TICKS
      }
    } else if (w.tick >= pk.availableAt) {
      pk.availableAt = 0
      w.events.push({ type: 'pickup_ready', spot: pk.spot })
    }
  }
}

/** Lose pickup weapons and dynamite (death, respawn). */
export function clearPickups(p: Player): void {
  p.weapon = WEAPON_REVOLVER
  p.weaponRounds = 0
  p.dynamite = 0
}

function spend(w: World, p: Player, intervalMs: number): void {
  p.weaponRounds--
  p.fireCooldownMs = (p.fireCooldownMs > -TICK_MS ? p.fireCooldownMs : 0) + intervalMs
  p.lastFireTick = w.tick
  p.protectUntil = Math.min(p.protectUntil, w.tick)
  p.stats.shots++
  if (p.weaponRounds <= 0) {
    p.weapon = WEAPON_REVOLVER
  }
}

/** A shot as the wire sees it: direction, how far it went, who it hit (or NONE), and flags. */
interface ShotTrace {
  angle: number
  range: number
  target: number
  flags: number
}

function shotEvent(w: World, p: Player, { angle, range, target, flags }: ShotTrace): void {
  w.events.push({
    type: 'shot',
    shooter: p.id,
    aim: radiansToAim(angle),
    range: Math.min(255, Math.round(range / SHOT_RANGE_UNIT)),
    target,
    flags,
    x: p.x,
    z: p.z,
  })
}

function fireRifle(w: World, p: Player, aim: number, viewTime: number): void {
  spend(w, p, RIFLE_FIRE_MS)
  const spread = spreadFor(p)
  p.bloom = bloomAfterShot(p.weapon, p.bloom)
  const angle = aimRadians(aim) + hashSigned(w.seed, p.id, w.tick, p.stats.shots) * spread * DEG
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  const wall = rayGrid(w.grid, { ox: p.x, oz: p.z, dx, dz, maxDist: RIFLE_RANGE }, BLOCK_SHOT)
  const time = rewindTime(w, viewTime)
  const hit = traceTargets(w, p, { dx, dz, maxT: wall }, time)
  let flags = SHOT_RIFLE
  if (hit) {
    flags |= SHOT_HIT
    strike(w, p, { targetId: hit.id, time, damage: RIFLE_DAMAGE, deadEye: false, aim })
  } else if (wall < RIFLE_RANGE) {
    flags |= SHOT_WALL
  }
  shotEvent(w, p, { angle, range: hit ? hit.t : wall, target: hit ? hit.id : NONE, flags })
}

function fireShotgun(w: World, p: Player, aim: number, viewTime: number): void {
  spend(w, p, SHOTGUN_FIRE_MS)
  const base = aimRadians(aim)
  const time = rewindTime(w, viewTime)
  const damage = new Map<number, number>()
  // the cone: tighter on the sights (spread.ts)
  const cone = spreadFor(p)
  for (let i = 0; i < SHOTGUN_PELLETS; i++) {
    // An even fan with a little jitter, so the pattern is fair but not a fixed comb.
    const lane = (i / (SHOTGUN_PELLETS - 1) - 0.5) * cone
    const jitter = hashSigned(w.seed, p.id, w.tick, i) * (cone / SHOTGUN_PELLETS / 2)
    const angle = base + (lane + jitter) * DEG
    const dx = Math.cos(angle)
    const dz = Math.sin(angle)
    const wall = rayGrid(w.grid, { ox: p.x, oz: p.z, dx, dz, maxDist: SHOTGUN_RANGE }, BLOCK_SHOT)
    const hit = traceTargets(w, p, { dx, dz, maxT: wall }, time)
    if (hit) {
      damage.set(hit.id, (damage.get(hit.id) ?? 0) + SHOTGUN_PELLET_DAMAGE)
    }
  }
  let target = NONE
  let most = 0
  for (const [id, dmg] of damage) {
    // One hit per target per shell, so stats count shells, not pellets.
    strike(w, p, { targetId: id, time, damage: dmg, deadEye: false, aim })
    if (dmg > most) {
      most = dmg
      target = id
    }
  }
  const range =
    target === NONE
      ? SHOTGUN_RANGE
      : Math.sqrt(dist2(p.x, p.z, w.players[target]?.x ?? p.x, w.players[target]?.z ?? p.z))
  shotEvent(w, p, {
    angle: base,
    range,
    target,
    flags: SHOT_SHOTGUN | (target === NONE ? 0 : SHOT_HIT),
  })
}

/** Fire the pickup weapon in hand. Assumes `canFire` passed and `p.weapon` isn't the revolver. */
export function firePickupWeapon(w: World, p: Player, aim: number, viewTime: number): void {
  if (p.weapon === WEAPON_RIFLE) {
    fireRifle(w, p, aim, viewTime)
  } else {
    fireShotgun(w, p, aim, viewTime)
  }
}

/** `BTN_THROW`: lob the stick along your aim, stopping short of walls. */
export function maybeThrow(w: World, p: Player, buttons: number, aim: number): void {
  const free =
    p.alive &&
    p.dynamite > 0 &&
    p.showdown < 0 &&
    p.lingerUntil < 0 &&
    p.rollTicks === 0 &&
    !vaulting(p)
  if (!(free && pressed(buttons, p.lastButtons, BTN_THROW))) {
    return
  }
  const a = aimRadians(aim)
  const dx = Math.cos(a)
  const dz = Math.sin(a)
  const reach = Math.max(
    0,
    rayGrid(w.grid, { ox: p.x, oz: p.z, dx, dz, maxDist: DYNAMITE_THROW_RANGE }, BLOCK_SIGHT) - 0.5,
  )
  const x = quantize(p.x + dx * reach)
  const z = quantize(p.z + dz * reach)
  p.dynamite = 0
  p.protectUntil = Math.min(p.protectUntil, w.tick)
  w.fuses.push({ by: p.id, x, z, explodeAt: w.tick + DYNAMITE_FUSE_TICKS })
  w.events.push({ type: 'dynamite_thrown', player: p.id, x, z, fuseTicks: DYNAMITE_FUSE_TICKS })
}

/** Blow lit fuses: 80 damage within 4 m behind no wall. Showdown rings and i-frames are immune. */
export function updateFuses(w: World): void {
  const due = w.fuses.filter((f) => w.tick >= f.explodeAt)
  if (due.length === 0) {
    return
  }
  w.fuses = w.fuses.filter((f) => w.tick < f.explodeAt)
  for (const f of due) {
    w.events.push({ type: 'explosion', by: f.by, x: f.x, z: f.z })
    for (const target of activePlayers(w)) {
      const inRange = dist2(f.x, f.z, target.x, target.z) <= DYNAMITE_RADIUS ** 2
      const immune =
        !target.alive || isProtected(w, target) || target.showdown >= 0 || inIframes(target)
      if (!inRange || immune || !hasLineOfSight(w.grid, f, target)) {
        continue
      }
      // The thrower may have left; then the blast is nobody's kill.
      const thrower = w.players[f.by]
      applyDamage(w, target, thrower && !thrower.gone ? thrower : target, {
        amount: DYNAMITE_DAMAGE,
        deadEye: false,
      })
    }
  }
}
