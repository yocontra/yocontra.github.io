/**
 * Pluggable opponents for the standoff engine. A seat is either a human (shots arrive over a
 * WebSocket) or an AI whose behaviour is decided by the server: an outlaw from the gauntlet tuning,
 * a Town Outlaw tuned near a rating, or a ghost sampled from a recorded player.
 */
import type { DuelTuning } from '../tuning.ts'
import type { PvpLink } from './judge-pvp.ts'

export type Rng = () => number

/** A human seat. The engine asks for the link at judging time, so the latest pings count. */
export interface HumanOpponent {
  kind: 'human'
  link: () => PvpLink
}

/** An AI seat. Everything it does is decided on the server and never revealed early. */
export interface AiOpponent {
  kind: 'outlaw' | 'ghost'
  /** Does this fake-out cue make it draw early? Called once per cue. */
  flinches: (cue: string) => boolean
  /** Spontaneous early draw while waiting: probability per second (0 for outlaws). */
  hazardPerSecond: number
  /**
   * At the call: when each of its shots lands, in ms after the call. One entry per target that
   * must be shot (the underboss has two). Empty means it froze.
   */
  draw: () => number[]
}

export type Opponent = HumanOpponent | AiOpponent

/** A missed first shot gives the player this much longer before the outlaw's second one lands. */
export const MISS_GRACE_MS = 250

export const between = (rng: Rng, min: number, max: number): number => min + rng() * (max - min)

/** The gauntlet's outlaw: exactly the ranked behaviour (draw ± jitter, misses add a grace). */
export function outlawOpponent(tuning: DuelTuning, rng: Rng = Math.random): AiOpponent {
  return {
    kind: 'outlaw',
    flinches: () => false,
    hazardPerSecond: 0,
    draw: () =>
      tuning.targets.map((target) => {
        const draw = target.drawMs + between(rng, -target.jitterMs, target.jitterMs)
        const hits = rng() < target.accuracy
        return hits ? draw : draw + MISS_GRACE_MS
      }),
  }
}

/**
 * A labelled Town Outlaw for when no ghost qualifies: a single target whose draw sits near the
 * player's hidden rating (a little slower, so it is beatable), with the gauntlet's miss grace.
 */
export function townOutlaw(ratingMs: number, rng: Rng = Math.random): AiOpponent {
  const drawMs = Math.max(200, Math.min(600, ratingMs + 25))
  return {
    kind: 'outlaw',
    flinches: () => false,
    hazardPerSecond: 0,
    draw: () => {
      const draw = drawMs + between(rng, -30, 30)
      return [rng() < 0.85 ? draw : draw + MISS_GRACE_MS]
    },
  }
}

/** What a recorded ghost profile needs for simulation (§6). */
export interface GhostTraits {
  /** Ring buffer of recent judged reactions. */
  reactions: readonly number[]
  duels: number
  froze: number
  fakesSeen: number
  fakeCowards: number
  waitCowards: number
  waitSeconds: number
}

export const GHOST_MIN_DRAW_MS = 140
const GHOST_NOISE_SD_MS = 8

/** Standard normal via Box–Muller. */
export function gaussian(rng: Rng): number {
  const u = Math.max(Number.EPSILON, rng())
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function ghostChances(t: GhostTraits): {
  freeze: number
  cueCoward: number
  hazard: number
} {
  return {
    freeze: (t.froze + 0.5) / (t.duels + 20),
    cueCoward: (t.fakeCowards + 1) / (t.fakesSeen + 20),
    hazard: (t.waitCowards + 0.5) / (t.waitSeconds + 60),
  }
}

/** A ghost: draws from the recorded distribution, with the recorded nerves. */
export function ghostOpponent(traits: GhostTraits, rng: Rng = Math.random): AiOpponent {
  const chances = ghostChances(traits)
  return {
    kind: 'ghost',
    flinches: () => rng() < chances.cueCoward,
    hazardPerSecond: chances.hazard,
    draw: () => {
      if (traits.reactions.length === 0 || rng() < chances.freeze) {
        return []
      }
      const sample = traits.reactions[Math.floor(rng() * traits.reactions.length)] ?? 260
      return [Math.max(GHOST_MIN_DRAW_MS, sample + GHOST_NOISE_SD_MS * gaussian(rng))]
    },
  }
}
