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
  pistol: freesound(392_229, 'Single Pistol Gunshot 3.3.wav', 'morganpurkis'),
  revolver38: freesound(346_905, 'Revolver calibre 38 - dois disparos', 'reishugo'),
  magnum: freesound(683_186, '357 Magnum Revolver Gunshot', 'Shark_Anthony'),
  magnumTail: freesound(683_175, '357 Magnum Revolver Gunshot with Tail', 'Shark_Anthony'),
  fallBoards: freesound(395_331, 'Body falling on the ground 1', 'ihitokage'),
  fallThud: freesound(346_695, 'Body fall_01.wav', 'deleted_user_2104797'),
} as const

const range = (stem: string, n: number) => Array.from({ length: n }, (_, i) => `${stem}_00${i}`)
const impact = (stem: string, n: number) => range(stem, n).map((x) => kenney(x, 'Impact Sounds'))
const rpg = (...names: string[]) => names.map((n) => kenney(n, 'RPG Audio'))

export const KENNEY = {
  concrete: impact('footstep_concrete', 5),
  grass: impact('footstep_grass', 5),
  snow: impact('footstep_snow', 5),
  metalMedium: impact('impactMetal_medium', 5),
  metalHeavy: impact('impactMetal_heavy', 5),
  metalLight: impact('impactMetal_light', 5),
  mining: impact('impactMining', 5),
  softMedium: impact('impactSoft_medium', 5),
  softHeavy: impact('impactSoft_heavy', 5),
  woodHeavy: impact('impactWood_heavy', 3),
  woodMedium: impact('impactWood_medium', 5),
  plank: impact('impactPlank_medium', 5),
  punch: impact('impactPunch_heavy', 5),
  cloth: rpg('cloth1', 'cloth2', 'cloth3', 'cloth4'),
  clothBelt: rpg('clothBelt', 'clothBelt2'),
  leather: rpg('beltHandle1', 'beltHandle2', 'handleSmallLeather', 'handleSmallLeather2'),
  dropLeather: kenney('dropLeather', 'RPG Audio'),
  boots: rpg(...Array.from({ length: 10 }, (_, i) => `footstep0${i}`)),
  creak: rpg('creak1', 'creak2', 'creak3'),
  metalClick: kenney('metalClick', 'RPG Audio'),
  metalLatch: kenney('metalLatch', 'RPG Audio'),
} as const

export const credit = (...sources: readonly Cc0Source[]): string =>
  `CC0: ${sources.map((s) => `${s.author}, "${s.title}" (${s.url})`).join('; ')}`
