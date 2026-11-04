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
  CoatCut,
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

/**
 * The gauntlet order, by name: the roster files hold the men, this holds the running order
 * (each man's `bounty` and `day` follow his slot here). The gimmicks teach early: the drunk's
 * wild timing at 4, the coin at 5 and the two-gun man's sure miss at 6, so 7–15 can lean on
 * draw speed and fake-outs. Must match `api/src/tuning.ts` row for row.
 */
const ORDER: readonly string[] = [
  'Bret P. Barsh',
  'Prescott J. House',
  'Calhoun C. Trine',
  'Burney N. Coover',
  'Ace Q. McConly',
  'Delmer F. Gusselman',
  'Salvador R. Gruell',
  'Felipe K. Wheeler',
  'Laura Bullion',
  'Thomas B. Arnold',
  'Pearl Hart',
  'Luke Short',
  'Dallas Stoudenmire',
  'Harvey “Kid Curry” Logan',
  'James “Wild Bill” Hickok',
  'William “Curly Bill” Brocius',
  'John Wesley Hardin',
]

const POOL: readonly Outlaw[] = [...ROSTER_EARLY, ...ROSTER_LATE]

export const OUTLAWS: readonly Outlaw[] = ORDER.map((name) => {
  const o = POOL.find((p) => p.name === name)
  if (!o) {
    throw new Error(`gauntlet order names an outlaw not on the roster: ${name}`)
  }
  return o
})

export const LEATHER_COLOR = LEATHER

/** The rifleman on the saloon's porch roof (underboss). */
export const RIFLEMAN_LOOK: Look = {
  base: 'casual',
  tint: { Shirt: 0x3a_32_26, Sleeves: 0x2a_20_18, Pants: 0x2a_20_18, Hair: 0x1a_10_08 },
  scale: 1.0,
  mask: true,
}

/** Underboss: the rifleman on the roof. */
export const RIFLEMAN = { draw: 300, jitter: 20, glintAt: 150, accuracy: 1 } as const
/** Boss phase 2. */
export const BOSS_PHASE2 = { draw: 292, jitter: 35 } as const
/** Boss phase 1 clock strike interval, seconds. */
export const BOSS_STRIKE_INTERVAL: readonly [number, number] = [1.1, 1.6]

/** 2019 curve for Legend mode: 1000 × 0.8^(level+1), floor 20 ms. */
export function legendDraw(index: number): number {
  return Math.max(20, 1000 * 0.8 ** (index + 1))
}

/** Extra ms granted by assist mode. */
export const ASSIST_MS = 150

/**
 * Extra ms on his draw when you're playing by touch. A tap reaches the page 35–60 ms after the
 * finger lands (touch sampling and the compositor), a key about 10 ms, so a phone player would
 * otherwise lose the same race a keyboard player wins. The ranked server adds the same amount
 * (`api/src/tuning.ts`). Your reaction is still timed honestly; only his shot waits.
 */
export const TOUCH_ALLOWANCE_MS = 40

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
