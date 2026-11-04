/**
 * What the out west 3D soundtrack is made of, and how loud each piece plays.
 *
 * Every file is mastered offline to a common reference (`tools/audio/build.ts`: SFX and beds about
 * −16 LUFS, music −18 LUFS, true peak ≤ −1 dBTP), so the balance lives here as explicit per-sound
 * `trim`s (dB) instead of being baked into the files. Call sites keep passing their own `gain` on
 * top.
 *
 * - One-shots are decoded (`SFX`). They are grouped into packs; only `core` loads up front, and
 *   `frontier` loads when Frontier starts (`AudioEngine.loadPack`).
 * - Beds and music are never decoded: they stream through media elements (`LOOPS`, `SONGS`,
 *   `STINGS`). A minute of decoded stereo is about 23 MB; the whole decoded set stays near 18 MB.
 * - The bell (`bell.m4a`) is the canonical call and is never regenerated. Nothing else in this
 *   catalog uses a bell or chime timbre.
 */
import { LOOP_POINTS } from './loop-points.ts'

const SFX_DIR = '/experiments/out-west/3d/sfx'
const MUSIC_DIR = '/experiments/out-west/3d/music'

export type Pack = 'core' | 'frontier'

export interface FileSfx {
  url: string
  pack: Pack
  /** Mix level, dB. */
  trim: number
  /** Where the sound really starts (s); every play skips ahead to it. */
  start?: number
  /** Buffer loop points, for decoded loops. */
  loop?: { start: number; end: number }
  /**
   * The file is `count` variants `step` s apart, each `len` s long. A play without an `offset`
   * picks one at random (so a plain `play()` never runs through every variant).
   */
  grid?: { count: number; step: number; len: number }
}

export interface Layer {
  of: FileName
  trim?: number
  rate?: number
  delay?: number
  /**
   * The town's answer to the shot rather than the shot itself: for a positioned sound it plays
   * unpanned (it comes from every wall) and falls off far more slowly than the direct sound, so a
   * distant shot is mostly tail, as it is outdoors.
   */
  diffuse?: boolean
}

const f = (
  name: string,
  trim: number,
  pack: Pack = 'core',
  extra: Partial<FileSfx> = {},
): FileSfx => ({
  url: `${SFX_DIR}/${name}.m4a`,
  pack,
  trim,
  ...extra,
})

/** Decoded one-shots. */
const FILES = {
  // the call: untouched canonical bell. Its first 230 ms are the previous strike's hum and the
  // strike then swells for ~25 ms (half its brightness at 246 ms), so plays start there: the strike
  // is at full brightness within a few ms of the call frame instead of ~35 ms after it
  bell: f('bell', 0, 'core', { start: 0.246 }),
  // revolver kit
  revClose: f('rev_close', 4),
  revTail: f('rev_tail', -3),
  cocking: f('cock', 6),
  hammer: f('hammer', 3),
  holster: f('holster', 4),
  whip: f('whip', 2),
  // impacts
  hitBody: f('hit_body', 1),
  hitWood: f('hit_wood', 0),
  hitDirt: f('hit_dirt', -1),
  ricochet: f('ricochet', 1, 'core', { grid: { count: 4, step: 1, len: 0.8 } }),
  flyby: f('flyby', 0),
  bodyfall: f('bodyfall', 0),
  // feet (grids: dirt and wood 6 steps 0.6 s apart, spurs 8 jingles 1 s apart)
  dirtsteps: f('dirtsteps', 2, 'core', { grid: { count: 6, step: 0.6, len: 0.5 } }),
  woodsteps: f('woodsteps', 2, 'core', { grid: { count: 6, step: 0.6, len: 0.5 } }),
  spursteps: f('spursteps', -5, 'core', { grid: { count: 8, step: 1, len: 0.7 } }),
  // people, animals, town
  shout: f('shout', 2),
  gasp: f('gasp', 0),
  crow: f('crow', 2),
  dog: f('dog', 1),
  hawk: f('hawk', 1.5),
  horse: f('horse', 0),
  door: f('door', 0),
  bottle: f('bottle', 0),
  piano: f('piano', -2),
  heart: f('heart', 1),
  // money
  coin: f('coin', 0),
  coins: f('coins', -2),
  register: f('register', -2, 'frontier'),
  deposit: f('deposit', 0, 'frontier'),
  // UI and meta
  uiPaper: f('ui_paper', 0),
  uiStamp: f('ui_stamp', 2),
  uiTick: f('ui_tick', -6),
  uiBuy: f('ui_buy', 0),
  queueFound: f('queue_found', 0),
  levelUp: f('levelup', -2),
  ghost: f('ghost', 0),
  ghostVanish: f('ghost_vanish', 0),
  // Frontier
  respawn: f('respawn', 0, 'frontier'),
  rifle: f('rifle', 4, 'frontier'),
  rifleLever: f('rifle_lever', 0, 'frontier'),
  shotgun: f('shotgun', 3, 'frontier'),
  shotgunLoad: f('shotgun_load', 0, 'frontier'),
  explosion: f('explosion', 4, 'frontier'),
  fuse: f('fuse', -6, 'frontier', { loop: LOOP_POINTS.fuse }),
} as const satisfies Record<string, FileSfx>

export type FileName = keyof typeof FILES

/** Layered sounds: several files fired together as one. */
const LAYERED = {
  /** Your revolver: the close crack and punch, then the street answering. */
  fire: [{ of: 'revClose' }, { of: 'revTail', delay: 0.012, diffuse: true }],
  /** A heavier, rounder report (outlaws' guns, and the generic far shot). */
  fireBig: [
    { of: 'revClose', rate: 0.9, trim: 1 },
    { of: 'revTail', rate: 0.94, trim: 2, delay: 0.015, diffuse: true },
  ],
  rifleFire: [{ of: 'rifle' }, { of: 'revTail', rate: 0.97, trim: -4, delay: 0.02, diffuse: true }],
  shotgunFire: [
    { of: 'shotgun' },
    { of: 'revTail', rate: 0.86, trim: -1, delay: 0.02, diffuse: true },
  ],
} as const satisfies Record<string, readonly Layer[]>

export type SfxName = FileName | keyof typeof LAYERED

export const SFX_FILES: Readonly<Record<FileName, FileSfx>> = FILES
export const SFX_LAYERS: Readonly<Partial<Record<SfxName, readonly Layer[]>>> = LAYERED

export function layersOf(name: SfxName): readonly Layer[] {
  return SFX_LAYERS[name] ?? [{ of: name as FileName }]
}

/** Voices that survive pool pressure. */
export const PRIORITY: ReadonlySet<SfxName> = new Set<SfxName>([
  'bell',
  'fire',
  'fireBig',
  'revClose',
  'revTail',
  'rifleFire',
  'shotgunFire',
  'explosion',
])

export interface StreamDef {
  url: string
  trim: number
  /** Loop points; absent for one-shot streams (stings). */
  points?: { start: number; end: number }
}

/** A looping stream (always has loop points). */
export interface LoopDef extends StreamDef {
  points: { start: number; end: number }
}

const amb = (file: keyof typeof LOOP_POINTS, trim: number): LoopDef => ({
  url: `${SFX_DIR}/${file}.m4a`,
  trim,
  points: LOOP_POINTS[file],
})

/** Streamed ambience beds, plus the decoded fuse loop. */
export const LOOPS = {
  /** The day wind (the default bed). */
  wind: amb('amb_wind_day', -7),
  windDusk: amb('amb_wind_dusk', -7),
  windNight: amb('amb_wind_night', -6),
  crickets: amb('amb_crickets', -4),
  saloon: amb('amb_saloon', -8),
  saloonPiano: amb('amb_piano', -6),
  /** Campfire crackle (an existing call-site name). */
  fire_loop: amb('amb_fire', -7),
} as const satisfies Record<string, LoopDef>

/** Loops that play from a decoded buffer instead of a stream (short, many at once, positional). */
export const BUFFER_LOOPS = { fuse: 'fuse' } as const satisfies Record<string, FileName>

export type LoopName = keyof typeof LOOPS | keyof typeof BUFFER_LOOPS

/**
 * Music is mastered to −18 LUFS, 5 dB under the 2019 files it replaces; this restores the level
 * the duel was mixed at ("music louder").
 */
export const MUSIC_TRIM = 5

const song = (file: string, points: { start: number; end: number }, trim = 0): LoopDef => ({
  url: `${MUSIC_DIR}/${file}.m4a`,
  trim: MUSIC_TRIM + trim,
  points,
})

export const SONGS = {
  /**
   * Title theme (the 2019 main theme, remastered, plays its intro once then loops): the title and
   * the end screen only.
   */
  intro: song('title', LOOP_POINTS.m_title),
  /** The saloon hub: a honky-tonk upright. */
  saloon: song('saloon', LOOP_POINTS.m_saloon),
  /** Act one (outlaws by daylight). */
  actDay: song('act_day', LOOP_POINTS.m_act_day),
  /** Act two (sunset). */
  actDusk: song('act_dusk', LOOP_POINTS.m_act_dusk),
  /** Act three (after dark). */
  actNight: song('act_night', LOOP_POINTS.m_act_night),
  /** The act themes again with a galloping percussion layer: you're on a streak. */
  actDayHot: song('act_day_hot', LOOP_POINTS.m_act_day_hot),
  actDuskHot: song('act_dusk_hot', LOOP_POINTS.m_act_dusk_hot),
  actNightHot: song('act_night_hot', LOOP_POINTS.m_act_night_hot),
  /** Midnight boss theme. */
  boss: song('boss', LOOP_POINTS.m_boss),
  /** Walk and standoff bed: low drones only, under the heartbeat and clear of the bell. */
  tension: song('tension', LOOP_POINTS.m_tension, -3),
  /** Frontier town loop. */
  frontier: song('frontier', LOOP_POINTS.m_frontier, -1),
} as const satisfies Record<string, LoopDef>

export type SongName = keyof typeof SONGS

/** First-try wins in a row that light the streak layer. */
export const STREAK_HOT = 3

/**
 * The act theme for an outlaw: by the light he's fought in (`day`: 0 noon … 1 midnight), the boss
 * theme for the last two, and the streak layer once you've beaten {@link STREAK_HOT} in a row
 * first time.
 */
export function actSong(level: number, day: number, streak = 0): SongName {
  if (level >= 15) {
    return 'boss'
  }
  const hot = streak >= STREAK_HOT
  if (day < 0.4) {
    return hot ? 'actDayHot' : 'actDay'
  }
  if (day < 0.8) {
    return hot ? 'actDuskHot' : 'actDusk'
  }
  return hot ? 'actNightHot' : 'actNight'
}

/**
 * First-try wins in a row going into `level` (0 on a retry): each earlier outlaw beaten on the
 * one attempt made against him.
 */
export function winStreak(
  level: number,
  attempts: Readonly<Record<number, number>>,
  best: Readonly<Record<number, unknown>>,
): number {
  if ((attempts[level] ?? 0) > 0) {
    return 0
  }
  let n = 0
  for (let k = level - 1; k >= 0 && attempts[k] === 1 && best[k]; k--) {
    n++
  }
  return n
}

const sting = (file: string): StreamDef => ({ url: `${MUSIC_DIR}/${file}.m4a`, trim: MUSIC_TRIM })

export const STINGS = {
  /** LIGHTNING and DEADEYE: the big fanfare. */
  victoryBig: sting('victory_big'),
  /** QUICK and STEADY. */
  victory: sting('victory'),
  /** LUCKY and a second chance: a wry, relieved twang. */
  victoryLucky: sting('victory_lucky'),
  defeat: sting('defeat'),
} as const satisfies Record<string, StreamDef>

export type StingName = keyof typeof STINGS

/** The victory sting for a draw grade (`gradeFor` in `data/outlaws.ts`). */
export function victorySting(grade: string): StingName {
  if (grade === 'LIGHTNING' || grade === 'DEADEYE') {
    return 'victoryBig'
  }
  if (grade === 'QUICK' || grade === 'STEADY') {
    return 'victory'
  }
  return 'victoryLucky'
}

export type UiName =
  | 'uiPaper'
  | 'uiStamp'
  | 'uiTick'
  | 'uiBuy'
  | 'queueFound'
  | 'levelUp'
  | 'ghost'
  | 'ghostVanish'
