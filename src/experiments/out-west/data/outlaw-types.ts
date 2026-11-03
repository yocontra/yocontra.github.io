/**
 * The shapes of an outlaw's tuning and look (design doc §3.4), shared by the roster files and
 * everything that reads them. The roster itself is `outlaws.ts`.
 */

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

/** Holster and belt leather. */
export const LEATHER = 0x5a_3a_22
/** Coal black for hats and kit. */
export const BLACK = 0x15_12_0f
