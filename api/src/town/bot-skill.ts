/**
 * How a server bot aims and fights, by skill (0 green … 1 sharp), and the practice town's base
 * skill from the player's record. See bots.ts for how a bot uses it.
 */

/** What a skill buys (see `aimFor`). */
export interface BotAim {
  /** Ticks from first seeing a target to the first shot. */
  reactTicks: number
  /** Most the aim swings in a tick (rad): a fast mover out-runs a slow hand. */
  turnRad: number
  /** Spread of the aim's wander (rad). */
  wanderRad: number
  /** Ticks between trigger pulls in a burst, before jitter. */
  fireTicks: number
  /** Shots in a burst, then a pause of `pauseTicks`. */
  burst: number
  pauseTicks: number
  /** Furthest a target is picked (m). */
  range: number
  /** Ticks a target hidden behind cover is remembered (and hunted, not shot). */
  memoryTicks: number
  /** At most this many bots fight one human at a time. */
  pack: number
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Skill (0 green … 1 sharp) → how the bot aims and fights. */
export function aimFor(skill: number): BotAim {
  const k = Math.min(1, Math.max(0, skill))
  let pack = 3
  if (k < 0.35) {
    pack = 1
  } else if (k < 0.7) {
    pack = 2
  }
  return {
    reactTicks: Math.round(lerp(14, 5, k)),
    turnRad: lerp(0.07, 0.4, k),
    wanderRad: lerp(0.15, 0.035, k),
    fireTicks: Math.round(lerp(17, 7, k)),
    burst: Math.round(lerp(2, 5, k)),
    pauseTicks: Math.round(lerp(26, 8, k)),
    range: lerp(15, 21, k),
    memoryTicks: Math.round(lerp(20, 60, k)),
    pack,
  }
}

/**
 * The practice town's base skill from the player's record on this device: a brand-new player
 * meets green bots; finished rounds and a winning ratio bring sharper ones.
 */
export function practiceSkill(rounds: number, kd: number): number {
  const r = Math.max(0, Math.min(16, Math.floor(Number.isFinite(rounds) ? rounds : 0)))
  const form = Math.min(0.15, Math.max(-0.08, ((Number.isFinite(kd) ? kd : 1) - 1) * 0.12))
  return Math.min(0.8, Math.max(0.1, 0.25 + 0.025 * r + form))
}
