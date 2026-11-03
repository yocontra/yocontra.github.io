// biome-ignore-all lint/style/useNamingConvention: keys mirror source asset material names (e.g. Brown_02) and Turnstile/three.js option names
/**
 * Every outlaw's tuning lives here (design doc §3.4). Times are in ms unless
 * noted. `day` is the time-of-day scalar used by the lighting presets:
 * 0 = high noon, 0.5 = sunset, 1 = midnight.
 */

import { LEATHER } from './outlaw-palette.ts'
import { EARLY_OUTLAWS } from './outlaws-early.ts'
import { LATE_OUTLAWS } from './outlaws-late.ts'

/**
 * Whole base characters. All but the woman share the player's rig (identical
 * skeleton, so the player's clips drive them); the woman has her own.
 */
export type BodyKey = 'suit' | 'rugged' | 'casual' | 'worker' | 'king' | 'punk' | 'woman'

export interface Look {
  /** Which whole character he is: never mixed with parts of another. */
  base: BodyKey
  /** Material name → hex colour. */
  tint: Readonly<Record<string, number>>
  /** Uniform build: 1 = a 1.78 m man. */
  scale: number
  coat?: number
  poncho?: number
  moustache?: number
  beard?: number
  bandoliers?: boolean
  star?: boolean
  mask?: boolean
}
export type HatKey = 'cowboy' | 'bowler' | 'sombrero' | 'tophat' | 'flat' | 'tall'
export type FakeKey =
  | 'crow'
  | 'door'
  | 'bottle'
  | 'horse'
  | 'coin'
  | 'twitch'
  | 'heckle'
  | 'piano'
  | 'gunshot'
  | 'dog'

export type Gimmick =
  | 'shaky'
  | 'talker'
  | 'counter'
  | 'coin'
  | 'drunk'
  | 'impatient'
  | 'windy'
  | 'cold'
  | 'whistler'
  | 'two-guns'
  | 'drr'
  | 'piano'
  | 'night'
  | 'fake-king'
  | 'cards'
  | 'underboss'
  | 'boss'

export interface Outlaw {
  readonly name: string
  readonly epithet: string
  readonly bounty: number
  readonly hook: string
  readonly gimmick: Gimmick
  /** How he looks: base character, colours, build and fitted accessories. */
  readonly look: Look
  readonly hat: HatKey
  readonly hatColor: number
  readonly bandana?: number
  readonly paces: readonly [number, number]
  /** Wait after the turn, in seconds. */
  readonly wait: readonly [number, number]
  /** Enemy draw time from the call, ms. */
  readonly draw: number
  readonly jitter: number
  /** Chance per wait slot that a fake-out fires (0..1). */
  readonly fakeChance: number
  readonly fakes: readonly FakeKey[]
  /** Chance his first shot hits. */
  readonly accuracy: number
  readonly day: number
  /** Lines he heckles with (captioned). */
  readonly lines: readonly string[]
}

export const OUTLAWS: readonly Outlaw[] = [...EARLY_OUTLAWS, ...LATE_OUTLAWS]

export const LEATHER_COLOR = LEATHER

/** The rifleman on the saloon's porch roof (underboss). */
export const RIFLEMAN_LOOK: Look = {
  base: 'casual',
  tint: {
    LightBrown: 0x3a_32_26,
    LightBlue: 0x2a_20_18,
    Hair: 0x1a_10_08,
    White: 0x2a_20_18,
    Red_Dark: 0x1a_14_10,
  },
  scale: 1.0,
  mask: true,
}

/** Underboss: the rifleman on the roof. */
export const RIFLEMAN = { draw: 330, jitter: 20, glintAt: 150, accuracy: 0.95 } as const
/** Boss phase 2. */
export const BOSS_PHASE2 = { draw: 280, jitter: 15 } as const
/** Boss phase 1 clock strike interval, seconds. */
export const BOSS_STRIKE_INTERVAL: readonly [number, number] = [1.1, 1.6]

/** 2019 curve for Legend mode: 1000 × 0.8^(level+1), floor 20 ms. */
export function legendDraw(index: number): number {
  return Math.max(20, 1000 * 0.8 ** (index + 1))
}

/** Extra ms granted by assist mode. */
export const ASSIST_MS = 150

export function gradeFor(ms: number, secondChance: boolean): string {
  if (secondChance) {
    return 'SECOND CHANCE'
  }
  if (ms < 180) {
    return 'LIGHTNING'
  }
  if (ms < 230) {
    return 'DEADEYE'
  }
  if (ms < 300) {
    return 'QUICK'
  }
  if (ms < 400) {
    return 'STEADY'
  }
  return 'LUCKY'
}
