// biome-ignore-all lint/style/noExcessiveLinesPerFile: one cohesive module (data table / scene builder); splitting would scatter tightly coupled code. Tracked for a later split.
// biome-ignore-all lint/style/useNamingConvention: keys mirror source asset material names (e.g. Brown_02) and Turnstile/three.js option names
/**
 * Every outlaw's tuning lives here (design doc §3.4). Times are in ms unless
 * noted. `day` is the time-of-day scalar used by the lighting presets:
 * 0 = high noon, 0.5 = sunset, 1 = midnight.
 */

import { bountyFor } from './economy.ts'

/**
 * Whole base characters. All but the woman share the player's rig (identical
 * skeleton, so the player's clips drive them); the woman has her own.
 */
export type BodyKey = 'suit' | 'rugged' | 'casual' | 'worker' | 'king' | 'punk' | 'woman'

export interface Look {
  /** Which whole character he is: never mixed with parts of another. */
  base: BodyKey
  /**
   * Garment → hex colour (the base GLB's material names: Shirt, Sleeves, Pants, Boots, Belt,
   * Bracer, Pauldron, Hair, Skin). A garment recolours its main fabric and keeps its detail.
   */
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

const LEATHER = 0x5a_3a_22
const BLACK = 0x15_12_0f

export const OUTLAWS: readonly Outlaw[] = [
  {
    name: 'Bret P. Barsh',
    epithet: 'the Greenhorn',
    bounty: bountyFor(0),
    hook: 'Hands shake. Drops his hat on the turn.',
    gimmick: 'shaky',
    look: {
      base: 'casual',
      tint: { Shirt: 0xd8_cc_b0, Pants: 0x4a_5a_6a, Boots: 0x6a_50_38, Hair: 0xc8_9a_5a },
      scale: 0.97,
    },
    hat: 'cowboy',
    hatColor: 0xb5_9a_6a,
    paces: [5, 7],
    wait: [1.0, 2.0],
    draw: 900,
    jitter: 50,
    fakeChance: 0,
    fakes: [],
    accuracy: 0.3,
    day: 0,
    lines: ['M-ma always said I was quick…', 'Is it… is it time yet?'],
  },
  {
    name: 'Prescott J. House',
    epithet: 'the Talker',
    bounty: bountyFor(1),
    hook: 'Heckles every pace.',
    gimmick: 'talker',
    look: {
      base: 'suit',
      tint: { Shirt: 0x6a_4a_30, Sleeves: 0x6a_4a_30, Pants: 0x3a_2a_1e, Hair: 0x2a_1a_10 },
      scale: 0.95,
      moustache: 0x2a_1a_10,
    },
    hat: 'bowler',
    hatColor: 0x2a_20_18,
    paces: [5, 8],
    wait: [1.0, 2.5],
    draw: 820,
    jitter: 60,
    fakeChance: 0,
    fakes: [],
    accuracy: 0.45,
    day: 0.02,
    lines: [
      'One! You walk like a mule.',
      'Two! My grandma draws faster.',
      'Three! Smell that? That’s fear.',
      'Four! Nice boots. I’ll take ’em.',
      'Five! Write your will yet?',
      'Six! Still walkin’, huh?',
      'Seven! I’m bored already.',
      'Eight! Turn around, coward.',
    ],
  },
  {
    name: 'Calhoun C. Trine',
    epithet: 'Can’t Count',
    bounty: bountyFor(2),
    hook: 'Counts paces aloud, wrongly. Watch for the crow.',
    gimmick: 'counter',
    look: {
      base: 'worker',
      tint: {
        Shirt: 0xa8_98_78,
        Sleeves: 0xa8_98_78,
        Pants: 0x5a_3a_20,
        Boots: 0x4a_3a_28,
        Hair: 0x8a_5a_2a,
      },
      scale: 1.05,
    },
    hat: 'cowboy',
    hatColor: 0x3b_2b_1c,
    paces: [6, 9],
    wait: [1.2, 2.8],
    draw: 750,
    jitter: 60,
    fakeChance: 0.2,
    fakes: ['crow'],
    accuracy: 0.55,
    day: 0.04,
    lines: ['One…', 'Two…', 'Four…', 'Seven…', 'Five?', 'Nine…', 'Uh… twelve…', 'Six!', 'Ten-ish…'],
  },
  {
    name: 'Ace Q. McConly',
    epithet: 'the Card Sharp',
    bounty: bountyFor(3),
    hook: 'Flips a coin. The coin landing is not the call.',
    gimmick: 'coin',
    look: {
      base: 'punk',
      tint: { Shirt: 0xe0_d8_c8, Sleeves: 0xe0_d8_c8, Pants: 0x1a_20_28, Hair: 0x10_10_10 },
      scale: 1.0,
      moustache: 0x10_10_10,
    },
    hat: 'flat',
    hatColor: 0x2b_2b_2b,
    paces: [5, 9],
    wait: [1.2, 3.0],
    draw: 690,
    jitter: 50,
    fakeChance: 0.3,
    fakes: ['coin'],
    accuracy: 0.65,
    day: 0.06,
    lines: ['Heads, you die. Tails, you die.'],
  },
  {
    name: 'Burney N. Coover',
    epithet: 'the Drunk',
    bounty: bountyFor(4),
    hook: 'Sways, swigs, and draws whenever he feels like it.',
    gimmick: 'drunk',
    look: {
      base: 'king',
      tint: {
        Shirt: 0x8a_7a_5a,
        Sleeves: 0xa8_98_78,
        Pants: 0x3a_2e_22,
        Pauldron: 0x5a_4a_3a,
        Hair: 0x9a_8a_7a,
      },
      scale: 0.93,
    },
    hat: 'cowboy',
    hatColor: 0x5a_4a_32,
    paces: [4, 10],
    wait: [1.0, 3.0],
    draw: 640,
    jitter: 150,
    fakeChance: 0.15,
    fakes: ['bottle'],
    accuracy: 0.4,
    day: 0.1,
    lines: ['*hic*', 'Which one of you’s real?', 'Hold still, the both of ya.'],
  },
  {
    name: 'Salvador R. Gruell',
    epithet: 'the Impatient',
    bounty: bountyFor(5),
    hook: 'Short walks. The call comes early.',
    gimmick: 'impatient',
    look: {
      base: 'rugged',
      tint: {
        Shirt: 0x8a_6a_4a,
        Sleeves: 0x8a_6a_4a,
        Pants: 0x4a_3a_2a,
        Hair: 0x1a_10_08,
        Skin: 0xe0_bc_9c,
      },
      scale: 0.98,
      poncho: 0xa0_28_1a,
      moustache: 0x1a_10_08,
    },
    hat: 'sombrero',
    hatColor: 0x9a_7a_4a,
    bandana: 0xa0_20_20,
    paces: [3, 5],
    wait: [0.8, 1.8],
    draw: 590,
    jitter: 50,
    fakeChance: 0.2,
    fakes: ['door', 'crow'],
    accuracy: 0.7,
    day: 0.25,
    lines: ['Vámonos, already.', 'I got a lunch to get to.'],
  },
  {
    name: 'Felipe K. Wheeler',
    epithet: 'the Long Walker',
    bounty: bountyFor(6),
    hook: 'Long walks. The wind picks up and the dust hides him.',
    gimmick: 'windy',
    look: {
      base: 'worker',
      tint: { Shirt: 0x8a_7a_5a, Sleeves: 0x8a_7a_5a, Pants: 0x5a_4a_38, Hair: 0x3a_24_12 },
      scale: 1.08,
      coat: 0xb0_94_68,
    },
    hat: 'cowboy',
    hatColor: 0x1e_1a_16,
    bandana: 0x2a_3a_6a,
    paces: [9, 13],
    wait: [1.5, 3.5],
    draw: 550,
    jitter: 40,
    fakeChance: 0.25,
    fakes: ['horse', 'door'],
    accuracy: 0.75,
    day: 0.42,
    lines: ['Keep walkin’, friend.'],
  },
  {
    name: 'Laura Bullion',
    epithet: 'the Thorny Rose',
    bounty: bountyFor(7),
    hook: 'Cold. Still. No tells at all.',
    gimmick: 'cold',
    look: {
      base: 'woman',
      tint: { Shirt: 0xc8_c0_b0, Sleeves: 0x2a_2a_2a, Pants: 0x2a_2a_2a, Hair: 0x1a_12_10 },
      scale: 0.95,
      coat: 0x1a_1a_1a,
    },
    hat: 'flat',
    hatColor: 0x1a_1a_1a,
    paces: [5, 10],
    wait: [1.5, 3.5],
    draw: 510,
    jitter: 20,
    fakeChance: 0.25,
    fakes: ['crow', 'door'],
    accuracy: 0.8,
    day: 0.5,
    lines: ['…'],
  },
  {
    name: 'Thomas B. Arnold',
    epithet: 'the Starer',
    bounty: bountyFor(8),
    hook: 'Whistles a dirge the whole walk. Never looks back.',
    gimmick: 'whistler',
    look: {
      base: 'suit',
      tint: { Shirt: 0x2a_1e_2a, Sleeves: 0x2a_1e_2a, Pants: 0x1a_1a_1e, Hair: 0x3a_2a_1a },
      scale: 1.1,
      coat: 0x14_12_1a,
    },
    hat: 'tophat',
    hatColor: BLACK,
    paces: [6, 10],
    wait: [1.5, 4.0],
    draw: 475,
    jitter: 40,
    fakeChance: 0.3,
    fakes: ['horse', 'bottle'],
    accuracy: 0.8,
    day: 0.56,
    lines: ['I can see you sweatin’.'],
  },
  {
    name: 'Delmer F. Gusselman',
    epithet: 'Two-Gun Delmer',
    bounty: bountyFor(9),
    hook: 'Two guns. Fires twice. The first always misses.',
    gimmick: 'two-guns',
    look: {
      base: 'casual',
      tint: { Shirt: 0x9a_6a_4a, Sleeves: 0x2a_2a_2a, Pants: 0x3a_30_28, Hair: 0x3a_24_12 },
      scale: 1.0,
      moustache: 0x3a_24_12,
    },
    hat: 'cowboy',
    hatColor: 0x6a_50_38,
    bandana: 0x20_20_20,
    paces: [5, 10],
    wait: [1.5, 4.0],
    draw: 445,
    jitter: 40,
    fakeChance: 0.25,
    fakes: ['door', 'coin'],
    accuracy: 0.9,
    day: 0.6,
    lines: ['Two’s better than one.'],
  },
  {
    name: 'Pearl Hart',
    epithet: 'the Stage Robber',
    bounty: bountyFor(10),
    hook: 'Her gang heckles. “DRR…” is not the call.',
    gimmick: 'drr',
    look: {
      base: 'woman',
      tint: { Shirt: 0xd8_cc_b8, Sleeves: 0x7a_2a_2a, Pants: 0x3a_1a_1a, Hair: 0x6a_3a_1a },
      scale: 0.94,
    },
    hat: 'cowboy',
    hatColor: 0x3a_2a_1a,
    paces: [5, 11],
    wait: [1.5, 4.0],
    draw: 420,
    jitter: 40,
    fakeChance: 0.4,
    fakes: ['heckle', 'heckle', 'crow'],
    accuracy: 0.85,
    day: 0.66,
    lines: ['The boys are watching.'],
  },
  {
    name: 'Luke Short',
    epithet: 'the Undertaker’s Friend',
    bounty: bountyFor(11),
    hook: 'Gambler. When the saloon piano stops, it’s not the call.',
    gimmick: 'piano',
    look: {
      base: 'punk',
      tint: { Shirt: 0xe8_e0_d0, Sleeves: 0x3a_1a_14, Pants: 0x1a_1a_22, Hair: 0x1a_12_0a },
      scale: 0.9,
      moustache: 0x1a_12_0a,
    },
    hat: 'bowler',
    hatColor: BLACK,
    paces: [5, 11],
    wait: [2.0, 4.5],
    draw: 395,
    jitter: 30,
    fakeChance: 0.4,
    fakes: ['piano', 'door'],
    accuracy: 0.85,
    day: 0.74,
    lines: ['Deal me in.'],
  },
  {
    name: 'Dallas Stoudenmire',
    epithet: 'the Marshal of El Paso',
    bounty: bountyFor(12),
    hook: 'Night. You can’t read his hand. Trust your ears.',
    gimmick: 'night',
    look: {
      base: 'rugged',
      tint: { Shirt: 0xa8_a0_90, Sleeves: 0x2a_26_20, Pants: 0x2a_26_20, Hair: 0x2a_1a_10 },
      scale: 1.1,
      coat: 0x2a_24_1c,
      star: true,
      moustache: 0x2a_1a_10,
    },
    hat: 'cowboy',
    hatColor: 0x2a_22_1a,
    paces: [6, 12],
    wait: [2.0, 4.5],
    draw: 375,
    jitter: 30,
    fakeChance: 0.35,
    fakes: ['dog', 'door', 'horse'],
    accuracy: 0.9,
    day: 0.86,
    lines: ['Lights out.'],
  },
  {
    name: 'Harvey “Kid Curry” Logan',
    epithet: 'the Fake-Out King',
    bounty: bountyFor(13),
    hook: 'Twitchy hands. Fake-outs everywhere.',
    gimmick: 'fake-king',
    look: {
      base: 'punk',
      tint: { Shirt: 0x7a_6a_5a, Sleeves: 0x10_10_10, Pants: 0x2a_30_38, Hair: 0x10_10_10 },
      scale: 1.02,
    },
    hat: 'cowboy',
    hatColor: 0x10_10_10,
    bandana: 0x8a_10_10,
    paces: [4, 12],
    wait: [2.0, 5.0],
    draw: 355,
    jitter: 30,
    fakeChance: 0.6,
    fakes: ['twitch', 'twitch', 'bottle', 'door', 'crow', 'coin'],
    accuracy: 0.9,
    day: 0.9,
    lines: ['Flinch.'],
  },
  {
    name: 'James “Wild Bill” Hickok',
    epithet: 'Aces and Eights',
    bounty: bountyFor(14),
    hook: 'Dead man’s hand. Metronomic.',
    gimmick: 'cards',
    look: {
      base: 'worker',
      tint: { Shirt: 0xd8_cc_b0, Sleeves: 0xd8_cc_b0, Pants: 0x4a_3a_2a, Hair: 0x6a_4a_2a },
      scale: 1.08,
      coat: 0x9a_7a_50,
    },
    hat: 'cowboy',
    hatColor: 0x2a_20_18,
    paces: [6, 10],
    wait: [2.0, 5.0],
    draw: 335,
    jitter: 10,
    fakeChance: 0.4,
    fakes: ['door', 'horse', 'twitch'],
    accuracy: 0.95,
    day: 0.92,
    lines: ['Aces and eights.'],
  },
  {
    name: 'William “Curly Bill” Brocius',
    epithet: 'the Underboss',
    bounty: bountyFor(15),
    hook: 'Rifleman on the saloon roof. Watch for the glint. Two shots.',
    gimmick: 'underboss',
    look: {
      base: 'rugged',
      tint: { Shirt: 0x5a_4a_3a, Sleeves: 0x1a_14_10, Pants: 0x3a_2a_1a, Hair: 0x0a_08_06 },
      scale: 1.06,
      poncho: 0x2a_20_18,
      bandoliers: true,
      beard: 0x0a_08_06,
    },
    hat: 'sombrero',
    hatColor: 0x2a_1a_10,
    bandana: 0x10_10_10,
    paces: [6, 12],
    wait: [2.0, 5.0],
    draw: 560,
    jitter: 20,
    fakeChance: 0.45,
    fakes: ['gunshot', 'door', 'bottle'],
    accuracy: 0.95,
    day: 0.95,
    lines: ['Look up, friend.'],
  },
  {
    name: 'John Wesley Hardin',
    epithet: 'the Boss',
    bounty: bountyFor(16),
    hook: 'Midnight. The twelfth strike is the call.',
    gimmick: 'boss',
    look: {
      base: 'suit',
      tint: { Shirt: 0x1a_1a_20, Sleeves: 0xcf_c6_b4, Pants: 0x0e_0e_12, Hair: 0x0a_0a_0a },
      scale: 1.12,
      coat: 0x0c_0c_10,
      moustache: 0x0a_0a_0a,
    },
    hat: 'tall',
    hatColor: BLACK,
    paces: [0, 0],
    wait: [1.5, 4.0],
    draw: 310,
    jitter: 15,
    fakeChance: 0.5,
    fakes: ['twitch', 'gunshot'],
    accuracy: 1,
    day: 1,
    lines: [],
  },
]

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
