/**
 * Public-domain (CC0 1.0) recordings behind the Frontier impact, footstep, near-miss and ambience
 * sounds. Each file sits in `tools/audio/cc0/` exactly as downloaded (the two long takes are cut
 * to the seconds used, without re-encoding); `recipes.ts` processes them into the shipped files.
 */
const CC0 = 'CC0 1.0 (creativecommons.org/publicdomain/zero/1.0)'
const DIR = `${import.meta.dir}/cc0`

export interface Cc0Source {
  file: string
  title: string
  author: string
  url: string
  license: string
}

const freesound = (id: number, title: string, author: string): Cc0Source => ({
  file: `${DIR}/freesound-${id}.mp3`,
  title,
  author,
  url: `https://freesound.org/s/${id}/`,
  license: CC0,
})

/** Kenney's packs: Impact Sounds 1.0 (2019) and RPG Audio 1.0, both CC0. */
const kenney = (name: string, pack: 'Impact Sounds' | 'RPG Audio'): Cc0Source => ({
  file: `${DIR}/${name}.ogg`,
  title: `${pack}: ${name}`,
  author: 'Kenney',
  url:
    pack === 'Impact Sounds'
      ? 'https://kenney.nl/assets/impact-sounds'
      : 'https://kenney.nl/assets/rpg-audio',
  license: CC0,
})

export const FREESOUND = {
  headshot: freesound(511_194, 'Headshot.wav', 'Pablobd'),
  concrete: freesound(321_478, 'Concrete Hit 2', 'dslrguide'),
  impacts: freesound(265_580, 'Impacts 01', 'aglinder'),
  gallery: freesound(
    675_951,
    'S31-15 Shooting gallery; hitting metal targets.wav (first 16 s)',
    'craigsmith',
  ),
  waterBullet: freesound(672_574, 'Water Bullet 2.wav', 'Teaganbear'),
  crack: freesound(386_854, 'Bullet Crack.wav', 'morganpurkis'),
  locoIdle: freesound(
    675_308,
    'S24-07 Old steam engine train idling and pumping steam',
    'craigsmith',
  ),
  wade: freesound(861_369, 'Splashing Footsteps Shallow Water', 'ChristopherJngs'),
  metalSteps: freesound(148_462, 'FOLEY_Footsteps_Metal_001.wav (first 12 s)', 'conleec'),
  sign: freesound(820_118, 'Old-Timey Saloon Sign (first 20 s)', 'SoundsCoolio'),
  whistle: freesound(71_778, 'Steam Whistle.mp3', 'Bidone'),
} as const

const range = (stem: string, n: number) => Array.from({ length: n }, (_, i) => `${stem}_00${i}`)

export const KENNEY = {
  concrete: range('footstep_concrete', 5).map((n) => kenney(n, 'Impact Sounds')),
  grass: range('footstep_grass', 5).map((n) => kenney(n, 'Impact Sounds')),
  metalMedium: range('impactMetal_medium', 3).map((n) => kenney(n, 'Impact Sounds')),
  metalHeavy: range('impactMetal_heavy', 3).map((n) => kenney(n, 'Impact Sounds')),
  softMedium: range('impactSoft_medium', 3).map((n) => kenney(n, 'Impact Sounds')),
  softHeavy: range('impactSoft_heavy', 3).map((n) => kenney(n, 'Impact Sounds')),
  woodHeavy: range('impactWood_heavy', 3).map((n) => kenney(n, 'Impact Sounds')),
  plank: range('impactPlank_medium', 3).map((n) => kenney(n, 'Impact Sounds')),
  cloth: ['cloth1', 'cloth2', 'cloth3', 'cloth4'].map((n) => kenney(n, 'RPG Audio')),
  creak: ['creak1', 'creak2', 'creak3'].map((n) => kenney(n, 'RPG Audio')),
  metalClick: kenney('metalClick', 'RPG Audio'),
  metalLatch: kenney('metalLatch', 'RPG Audio'),
} as const

export const credit = (...sources: readonly Cc0Source[]): string =>
  `CC0: ${sources.map((s) => `${s.author}, "${s.title}" (${s.url})`).join('; ')}`
