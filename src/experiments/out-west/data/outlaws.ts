// biome-ignore-all lint/style/useNamingConvention: tint keys mirror the base GLB's material names (Shirt, Sleeves, Pants…)
/**
 * Every outlaw's tuning (design doc §3.4): the 17-strong roster (split across `roster-early.ts` and
 * `roster-late.ts`), the underboss's rifleman, the boss's second phase, Legend mode and the draw
 * grades. Times are in ms unless noted. `day` is the time-of-day scalar used by the lighting
 * presets: 0 = high noon, 0.5 = sunset, 1 = midnight.
 */
import { LEATHER, type Look, type Outlaw } from './outlaw-types.ts'
import { ROSTER_EARLY } from './roster-early.ts'
import { ROSTER_LATE } from './roster-late.ts'

export type {
  BeardKey,
  BodyKey,
  Build,
  FaceShape,
  FakeKey,
  Gimmick,
  HairKey,
  HatKey,
  Look,
  MoustacheKey,
  Outlaw,
  SkinKey,
  Stance,
} from './outlaw-types.ts'

export const OUTLAWS: readonly Outlaw[] = [...ROSTER_EARLY, ...ROSTER_LATE]

export const LEATHER_COLOR = LEATHER

/** The rifleman on the saloon's porch roof (underboss). */
export const RIFLEMAN_LOOK: Look = {
  base: 'casual',
  tint: { Shirt: 0x3a_32_26, Sleeves: 0x2a_20_18, Pants: 0x2a_20_18, Hair: 0x1a_10_08 },
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
