/**
 * The shapes of an outlaw's tuning and look (design doc §3.4), shared by the roster files and
 * everything that reads them. The roster itself is `outlaws.ts`.
 */

/**
 * Whole base characters. All but the woman share the player's rig (identical
 * skeleton, so the player's clips drive them); the woman has her own.
 */
export type BodyKey = 'suit' | 'rugged' | 'casual' | 'worker' | 'king' | 'punk' | 'woman'

/** Skin tone: a multiplier on the atlas skin (scene/person.ts). `tan` is the atlas as painted. */
export type SkinKey = 'pale' | 'fair' | 'ruddy' | 'tan' | 'olive' | 'brown' | 'dark'
/**
 * Hair cut, borrowed from the base that wears it (same skeleton, same head): `short` (casual),
 * `crop` (worker), `long` (king), or none.
 */
export type HairKey = 'short' | 'crop' | 'long' | 'bald'
export type MoustacheKey = 'handlebar' | 'walrus' | 'pencil' | 'horseshoe' | 'chevron'
/** `sculpted`: the base's own beard mesh; the others are fitted shells (scene/face.ts). */
export type BeardKey = 'sculpted' | 'full' | 'goatee'

/** Proportions as bone scales and offsets, 1 = the base as built. Baked before he is measured. */
export interface Build {
  /** Head size (uniform). */
  head?: number
  /** Neck length. */
  neck?: number
  /** Shoulder width (collarbone length). */
  shoulders?: number
  /** Chest girth. */
  chest?: number
  /** Belly girth. */
  belly?: number
}

/** The lower face, reshaped on the bind mesh: + wider jaw / longer face, − narrower / shorter. */
export interface FaceShape {
  jaw?: number
  long?: number
}

/** A standing habit, radians, layered on every clip: head tilt, chin up (+), lean forward (+). */
export interface Stance {
  tilt?: number
  chin?: number
  lean?: number
  /** Weight on one hip: the upper body leans over it (+ his left). */
  hip?: number
}

export interface Look {
  /** Which whole character he is: never mixed with parts of another. */
  base: BodyKey
  /**
   * Garment → hex colour (the base GLB's material names: Shirt, Sleeves, Pants, Boots, Belt,
   * Bracer, Pauldron, Hair). A garment recolours its main fabric and keeps its detail. Hair is
   * the colour it reads as (scene/person.ts normalises it by the atlas's grey hair).
   */
  tint: Readonly<Record<string, number>>
  /** Uniform build: 1 = a 1.78 m man. */
  scale: number
  coat?: number
  poncho?: number
  /** Waistcoat over the shirt, open at the front. */
  vest?: number
  moustache?: number
  moustacheStyle?: MoustacheKey
  beard?: number
  beardStyle?: BeardKey
  /** Side whiskers down to the jaw (colour). */
  sideburns?: number
  /** Unshaven jaw, 0..1. */
  stubble?: number
  bandoliers?: boolean
  star?: boolean
  mask?: boolean
  skin?: SkinKey
  hair?: HairKey
  build?: Build
  face?: FaceShape
  /** Patch over his left eye. */
  eyepatch?: boolean
  /** A knife scar across his right cheek. */
  scar?: boolean
  /** Leather gloves (colour). */
  gloves?: number
  stance?: Stance
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

/** Holster and belt leather. */
export const LEATHER = 0x5a_3a_22
/** Coal black for hats and kit. */
export const BLACK = 0x15_12_0f
