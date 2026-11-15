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
  /** Downloaded bytes, retained unchanged for reproducible source provenance. */
  sha256?: string
  downloadUrl?: string
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
  // biome-ignore-start lint/security/noSecrets: verified public recording checksums, not credentials.
  magnumExterior: {
    ...freesound(232_750, '357 Magnum Ext.wav', 'klangfabrik'),
    downloadUrl: 'https://cdn.freesound.org/previews/232/232750_181941-hq.mp3',
    sha256: '31a848a4256bb5c876771e82f1106689bb16a4866af18a50a9b5e12896738a43',
  },
  timber319223: {
    ...freesound(319_223, 'Single Rock Hitting wood 3.wav', 'worthahep88'),
    downloadUrl: 'https://cdn.freesound.org/previews/319/319223_3443504-hq.mp3',
    sha256: 'ef856eb9bacf28f846e8cbeebb7f7c908e53a4c37714561000dbccb87d45fd4f',
  },
  timber319226: {
    ...freesound(319_226, 'Single rock hitting wood.wav', 'worthahep88'),
    downloadUrl: 'https://cdn.freesound.org/previews/319/319226_3443504-hq.mp3',
    sha256: '11644f060e7587435e97b29681170999c532f719fc2bbe8d18148909d88a8d5d',
  },
  timber319227: {
    ...freesound(319_227, 'Single Rock hitting wood 4.wav', 'worthahep88'),
    downloadUrl: 'https://cdn.freesound.org/previews/319/319227_3443504-hq.mp3',
    sha256: '5edd67c89260afd952ac06daf093393870e3132d2b4b1be07c58d456a1eff71a',
  },
  timber319228: {
    ...freesound(319_228, 'Single Rock hitting wood 2.wav', 'worthahep88'),
    downloadUrl: 'https://cdn.freesound.org/previews/319/319228_3443504-hq.mp3',
    sha256: '5185497818496fdbcb4c64bfd4eff7d809e06024adda4efac4fbcc4fcc16d4ff',
  },
  cowboyBoards: {
    ...freesound(852_320, 'FL-Footsteps,Boot,Cowboy,Wood,Plank', 'soundandmelodies'),
    downloadUrl: 'https://cdn.freesound.org/previews/852/852320_10924423-hq.mp3',
    sha256: '679d741fa033f392a3d5de8b74a7cb28de4a7cdc3294e08426316699b3b63d7d',
  },
  revolver38Session: {
    ...freesound(835_200, 'Revolver Gunshots (.38 special)', 'C-V'),
    downloadUrl: 'https://cdn.freesound.org/previews/835/835200_8956746-hq.mp3',
    sha256: '7c6aba8e632d457a158a02d1a93f0527e6727add2e83616806b6453fb642e0cc',
  },
  // biome-ignore-end lint/security/noSecrets: verified public recording checksums, not credentials.
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
