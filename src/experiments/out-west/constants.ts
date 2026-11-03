// Gameplay tuning, carried over verbatim from the 2019 original.
export const MAX_SPEED = 5
export const MAX_PACES = 200
export const MIN_PACES = 100
export const DIFFICULTY = 0.8
export const FRICTION = 0.65
export const INITIAL_DRAW_TIME = 1000
/** Floor for the enemy's reaction time in ms. */
export const MIN_DRAW_TIME = 20

export const SPRITE_WIDTH = 160
export const SPRITE_HEIGHT = 230

/** Intro music plays alone for this long before the duel begins. */
export const INTRO_DURATION = 13000
export const NAME_DURATION = 2000
export const COCK_DELAY = 2000
export const RESULT_DURATION = 3000
export const COWARD_DURATION = 2000
export const NEXT_LEVEL_DELAY = 3000

/** The original physics ran once per animation frame on 60Hz screens. */
export const TICK_MS = 1000 / 60

/**
 * Narrowest logical world width. Smaller screens render the world scaled
 * down instead of cropping it, so the enemy never walks off a phone screen.
 * Gameplay distances (paces, speeds) stay in logical pixels.
 */
export const MIN_WORLD_WIDTH = 1200

export const NAMES = [
  'Bret P. Barsh',
  'Prescott J. House',
  'Calhoun C. Trine',
  'Ace Q. McConly',
  'Burney N. Coover',
  'Salvador R. Gruell',
  'Felipe K. Wheeler',
  'Laura Bullion',
  'Thomas B. Arnold',
  'Delmer F. Gusselman',
  'Pearl Hart',
  'Luke Short',
  'Dallas Stoudenmire',
  'Harvey “Kid Curry” Logan',
  'James “Wild Bill” Hickok',
  'Underboss: William “Curly Bill” Brocius',
  'Boss: John Wesley Hardin',
] as const

const ASSET_ROOT = '/experiments/out-west/assets'

export const SPRITES = {
  playerFire: `${ASSET_ROOT}/player-fire.png`,
  playerWalk: `${ASSET_ROOT}/player-walk.png`,
  enemyFire: `${ASSET_ROOT}/enemy-fire.png`,
  enemyWalk: `${ASSET_ROOT}/enemy-walk.png`,
} as const

export const SOUNDS = {
  cocking: `${ASSET_ROOT}/cocking.m4a`,
  fire: `${ASSET_ROOT}/fire.m4a`,
  fireBig: `${ASSET_ROOT}/fire-big.m4a`,
  shout: `${ASSET_ROOT}/shout.m4a`,
  whip: `${ASSET_ROOT}/whip.m4a`,
} as const

export const SONGS = {
  intro: `${ASSET_ROOT}/intro.m4a`,
  boss: `${ASSET_ROOT}/boss.m4a`,
} as const

export type SpriteName = keyof typeof SPRITES
export type SoundName = keyof typeof SOUNDS
export type SongName = keyof typeof SONGS
