/**
 * Every outlaw's tuning lives here (design doc §3.4). Times are in ms unless
 * noted. `day` is the time-of-day scalar used by the lighting presets:
 * 0 = high noon, 0.5 = sunset, 1 = midnight.
 */

import { bountyFor } from './economy'

/** Character part sources (all share the player's rig), plus the woman model. */
export type PartSrc = 'suit' | 'rugged' | 'casual' | 'worker' | 'king' | 'punk'
export type BodyKey = PartSrc | 'woman'

export interface Look {
  /** Use the whole woman model instead of kitbashed parts. */
  woman?: boolean
  head: PartSrc
  body: PartSrc
  legs: PartSrc
  feet: PartSrc
  /** Material name → hex colour. */
  tint: Readonly<Record<string, number>>
  /** [width, height] build multipliers. */
  build: readonly [number, number]
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
  /** How he looks: kitbashed body parts, outfit, accessories (see LOOKS). */
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

const LEATHER = 0x5a3a22
const BLACK = 0x15120f

export const OUTLAWS: readonly Outlaw[] = [
  {
    name: 'Bret P. Barsh',
    epithet: 'the Greenhorn',
    bounty: bountyFor(0),
    hook: 'Hands shake. Drops his hat on the turn.',
    gimmick: 'shaky',
    look: {
      head: 'casual',
      body: 'casual',
      legs: 'casual',
      feet: 'worker',
      tint: { LightBrown: 0xd8ccb0, LightBlue: 0x4a5a6a, Hair: 0xc89a5a },
      build: [0.9, 0.97],
    },
    hat: 'cowboy',
    hatColor: 0xb59a6a,
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
      head: 'suit',
      body: 'suit',
      legs: 'suit',
      feet: 'suit',
      tint: { Suit: 0x6a4a30, Tie: 0x8a1a10, Hair: 0x2a1a10 },
      build: [1.18, 0.95],
      moustache: 0x2a1a10,
    },
    hat: 'bowler',
    hatColor: 0x2a2018,
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
      head: 'punk',
      body: 'worker',
      legs: 'worker',
      feet: 'worker',
      tint: {
        Worker_Vest: 0x5a3a20,
        LightBrown: 0xa89878,
        Worker_Yellow: 0x8a6a3a,
        Brown: 0x6a5a40,
        Brown2: 0x4a3a28,
      },
      build: [1, 1.05],
    },
    hat: 'cowboy',
    hatColor: 0x3b2b1c,
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
      head: 'suit',
      body: 'punk',
      legs: 'suit',
      feet: 'suit',
      tint: { Black: 0x1a2028, White: 0xe0d8c8, Suit: 0x2a2a30, Hair: 0x101010 },
      build: [0.95, 1.0],
      moustache: 0x101010,
    },
    hat: 'flat',
    hatColor: 0x2b2b2b,
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
      head: 'king',
      body: 'casual',
      legs: 'rugged',
      feet: 'worker',
      tint: { LightBrown: 0x8a7a5a, Brown: 0x5a4a3a, Brown2: 0x3a2e22, Hair_White: 0x9a8a7a },
      build: [1.2, 0.93],
    },
    hat: 'cowboy',
    hatColor: 0x5a4a32,
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
      head: 'rugged',
      body: 'rugged',
      legs: 'rugged',
      feet: 'rugged',
      tint: { Green: 0x6a2e1e, LightGreen: 0x8a6a4a, Brown: 0x4a3a2a, Hair: 0x1a1008 },
      build: [1.05, 0.98],
      poncho: 0xa0281a,
    },
    hat: 'sombrero',
    hatColor: 0x9a7a4a,
    bandana: 0xa02020,
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
      head: 'worker',
      body: 'rugged',
      legs: 'worker',
      feet: 'rugged',
      tint: { Green: 0x8a7a5a, LightGreen: 0x6a5a40, Brown: 0x5a4a38, Moustache: 0x3a2412 },
      build: [0.94, 1.08],
      coat: 0xb09468,
    },
    hat: 'cowboy',
    hatColor: 0x1e1a16,
    bandana: 0x2a3a6a,
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
      woman: true,
      head: 'casual',
      body: 'casual',
      legs: 'casual',
      feet: 'casual',
      tint: { LightGreen: 0x2a2a2a, Green: 0x3a2020, White: 0xc8c0b0 },
      build: [1, 1],
      coat: 0x1a1a1a,
    },
    hat: 'flat',
    hatColor: 0x1a1a1a,
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
      head: 'casual',
      body: 'suit',
      legs: 'suit',
      feet: 'suit',
      tint: { Suit: 0x2a1e2a, Tie: 0x101010, White: 0xc8c0b0, Hair: 0x3a2a1a },
      build: [0.88, 1.1],
      coat: 0x14121a,
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
      head: 'punk',
      body: 'worker',
      legs: 'worker',
      feet: 'rugged',
      tint: {
        Worker_Vest: 0x2a2a2a,
        LightBrown: 0x9a6a4a,
        Worker_Yellow: 0x2a2a2a,
        Brown: 0x4a3828,
      },
      build: [1.12, 1.0],
      moustache: 0x3a2412,
    },
    hat: 'cowboy',
    hatColor: 0x6a5038,
    bandana: 0x202020,
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
      woman: true,
      head: 'casual',
      body: 'casual',
      legs: 'casual',
      feet: 'casual',
      tint: { LightGreen: 0x7a2a2a, Green: 0x3a1a1a, White: 0xd8ccb8 },
      build: [1, 1],
    },
    hat: 'cowboy',
    hatColor: 0x3a2a1a,
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
      head: 'suit',
      body: 'punk',
      legs: 'suit',
      feet: 'suit',
      tint: { Black: 0x3a1a14, White: 0xe8e0d0, Suit: 0x1a1a22, Hair: 0x1a120a },
      build: [1.02, 0.88],
      moustache: 0x1a120a,
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
      head: 'rugged',
      body: 'suit',
      legs: 'rugged',
      feet: 'worker',
      tint: { Suit: 0x2a2620, White: 0xa8a090, Tie: 0x101010, Brown: 0x2a2620 },
      build: [1.05, 1.1],
      coat: 0x2a241c,
      star: true,
    },
    hat: 'cowboy',
    hatColor: 0x2a221a,
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
      head: 'casual',
      body: 'punk',
      legs: 'punk',
      feet: 'worker',
      tint: { Black: 0x101010, White: 0x7a6a5a, LightBlue: 0x2a3038, Hair: 0x0a0a0a },
      build: [0.95, 1.02],
    },
    hat: 'cowboy',
    hatColor: 0x101010,
    bandana: 0x8a1010,
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
      head: 'worker',
      body: 'suit',
      legs: 'suit',
      feet: 'worker',
      tint: { Suit: 0x8a6a44, White: 0xd8ccb0, Tie: 0x101010, Moustache: 0x6a4a2a },
      build: [1.0, 1.08],
      coat: 0x9a7a50,
    },
    hat: 'cowboy',
    hatColor: 0x2a2018,
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
      head: 'rugged',
      body: 'worker',
      legs: 'rugged',
      feet: 'worker',
      tint: {
        Worker_Vest: 0x1a1410,
        LightBrown: 0x5a4a3a,
        Worker_Yellow: 0x1a1410,
        Brown: 0x3a2a1a,
        Hair: 0x0a0806,
      },
      build: [1.22, 1.03],
      poncho: 0x2a2018,
      bandoliers: true,
    },
    hat: 'sombrero',
    hatColor: 0x2a1a10,
    bandana: 0x101010,
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
      head: 'suit',
      body: 'suit',
      legs: 'suit',
      feet: 'suit',
      tint: { Suit: 0x0e0e12, Tie: 0x5a0000, White: 0xcfc6b4, Hair: 0x0a0a0a },
      build: [1.0, 1.12],
      coat: 0x0c0c10,
      moustache: 0x0a0a0a,
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
  head: 'worker',
  body: 'casual',
  legs: 'worker',
  feet: 'worker',
  tint: { LightBrown: 0x3a3226, Brown: 0x2a2018, Moustache: 0x1a1008 },
  build: [1, 1],
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
  if (secondChance) return 'SECOND CHANCE'
  if (ms < 180) return 'LIGHTNING'
  if (ms < 230) return 'DEADEYE'
  if (ms < 300) return 'QUICK'
  if (ms < 400) return 'STEADY'
  return 'LUCKY'
}
