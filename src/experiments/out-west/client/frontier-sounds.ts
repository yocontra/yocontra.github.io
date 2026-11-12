/**
 * What Frontier's world sounds are made of and how far each family carries. Files are mastered by
 * `tools/audio/build.ts`; the gridded layouts match `tools/audio/frontier-recipes.ts`
 * (`FRONTIER_GRIDS`) and `recipes.ts`, and the loop points come from `audio/loop-points.ts`.
 */
import { LOOP_POINTS } from '../audio/loop-points.ts'
import { itemById } from '../data/catalog.ts'
import { getSettings } from '../settings.ts'
import type { GameApplication } from './application.ts'
import type { StepSurface } from './audio-surfaces.ts'

export const SFX_DIR = '/experiments/out-west/3d/sfx'

export interface SoundGrid {
  count: number
  step: number
  len: number
}
export interface SoundDef {
  file: string
  /** Mix level, dB at or under 0 (a native slot's volume tops out at 1). */
  trim: number
  grid?: SoundGrid
  loop?: { start: number; end: number }
}
const g = (count: number, step: number, len: number): SoundGrid => ({ count, step, len })

export const SOUNDS = {
  shot: { file: 'rev_close', trim: -3 },
  tail: { file: 'rev_tail', trim: -8 },
  rifle: { file: 'rifle', trim: -3 },
  shotgun: { file: 'shotgun', trim: -3 },
  lever: { file: 'rifle_lever', trim: -6 },
  shell: { file: 'shotgun_load', trim: -6 },
  reload: { file: 'foley_reload', trim: -1 },
  holster: { file: 'holster', trim: -6 },
  cock: { file: 'cock', trim: -6 },
  body: { file: 'hit_flesh', trim: -2, grid: g(4, 0.5, 0.42) },
  stone: { file: 'hit_stone', trim: -3, grid: g(6, 0.6, 0.55) },
  metal: { file: 'hit_metal', trim: -3, grid: g(4, 0.9, 0.85) },
  water: { file: 'hit_water', trim: -3, grid: g(4, 0.7, 0.6) },
  soft: { file: 'hit_soft', trim: -4, grid: g(4, 0.5, 0.4) },
  wood: { file: 'hit_timber', trim: -2, grid: g(4, 0.6, 0.5) },
  dirt: { file: 'hit_ground', trim: -3, grid: g(4, 0.6, 0.5) },
  stepDirt: { file: 'dirtsteps', trim: 0, grid: g(6, 0.6, 0.5) },
  stepWood: { file: 'woodsteps', trim: -2, grid: g(6, 0.6, 0.5) },
  stepStone: { file: 'steps_stone', trim: 0, grid: g(5, 0.5, 0.4) },
  stepStraw: { file: 'steps_straw', trim: -1, grid: g(5, 0.5, 0.4) },
  stepMetal: { file: 'steps_metal', trim: -6, grid: g(6, 0.7, 0.6) },
  stepWater: { file: 'steps_water', trim: -3, grid: g(6, 0.7, 0.6) },
  spurs: { file: 'spursteps', trim: -9, grid: g(8, 1, 0.7) },
  cloth: { file: 'foley_cloth', trim: -4, grid: g(4, 0.6, 0.5) },
  hitMarker: { file: 'ui_hit', trim: -3 },
  kill: { file: 'ui_kill', trim: -2 },
  crack: { file: 'crack', trim: -2, grid: g(3, 0.5, 0.42) },
  flyby: { file: 'flyby', trim: -4 },
  fall: { file: 'bodyfall', trim: -3 },
  deposit: { file: 'deposit', trim: -2 },
  bell: { file: 'bell', trim: 0 },
  fake0: { file: 'crow', trim: -2 },
  fake1: { file: 'cock', trim: -2 },
  fake2: { file: 'door', trim: -2 },
  explosion: { file: 'explosion', trim: 0 },
  respawn: { file: 'respawn', trim: -3 },
  heart: { file: 'heart', trim: -4 },
  crow: { file: 'crow', trim: -8 },
  dog: { file: 'dog', trim: -9 },
  horse: { file: 'horse', trim: -9 },
  hawk: { file: 'hawk', trim: -12 },
  creak: { file: 'sign_creak', trim: -6, grid: g(5, 2, 1.9) },
  whistle: { file: 'whistle', trim: -8 },
  loco: { file: 'amb_loco', trim: -6, loop: LOOP_POINTS.amb_loco },
  wind: { file: 'amb_frontier_wind', trim: -9, loop: LOOP_POINTS.amb_frontier_wind },
  murmur: { file: 'amb_murmur', trim: -8, loop: LOOP_POINTS.amb_murmur },
} as const satisfies Record<string, SoundDef>

export type FrontierSound = keyof typeof SOUNDS

/** How a family falls off with distance: PlayCanvas positional settings, plus a hard cull. */
export interface Range {
  model: 'linear' | 'inverse' | 'exponential'
  ref: number
  max: number
  rolloff: number
  /** Not played at all beyond this many metres. */
  cull: number
}
export const RANGES = {
  /** The close report: carries across the whole town. */
  gun: { model: 'inverse', ref: 6, max: 400, rolloff: 0.9, cull: 500 },
  /** The town's answer: falls off far slower than the crack. */
  tail: { model: 'inverse', ref: 22, max: 600, rolloff: 0.45, cull: 600 },
  impact: { model: 'inverse', ref: 2.5, max: 50, rolloff: 1.1, cull: 55 },
  /** Footsteps: readable to about 26 m and silent past it (competitive range, not the whole map). */
  step: { model: 'linear', ref: 1.5, max: 26, rolloff: 1, cull: 26 },
  foley: { model: 'linear', ref: 1.5, max: 18, rolloff: 1, cull: 18 },
  near: { model: 'inverse', ref: 1, max: 12, rolloff: 1.4, cull: 12 },
  amb: { model: 'inverse', ref: 4, max: 45, rolloff: 1, cull: 60 },
  far: { model: 'inverse', ref: 30, max: 400, rolloff: 0.6, cull: 500 },
} as const satisfies Record<string, Range>
export type RangeName = keyof typeof RANGES

export const STEP_SOUND: Readonly<Record<StepSurface, FrontierSound>> = {
  dirt: 'stepDirt',
  wood: 'stepWood',
  stone: 'stepStone',
  metal: 'stepMetal',
  straw: 'stepStraw',
  water: 'stepWater',
}

export const db = (v: number) => 10 ** (v / 20)
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** The player's SFX slider; the showdown bell is the cue and answers to none. */
export const slider = (name: FrontierSound) => (name === 'bell' ? 1 : getSettings().sfx)

/** Steps per second at a horizontal speed (crouch 2.9 → 2.1/s, run 5.5 → 2.8/s, sprint 7.6 → 3.4/s). */
export const stepRate = (speed: number) => 1.3 + speed * 0.27

/** The rider's spur item's timbre (every loadout wears spurs; the starter rowels rattle). */
export function spurTimbre(spurs: string | undefined): 'jingle' | 'rattle' | null {
  const sound = spurs ? itemById(spurs)?.sound : undefined
  if (sound?.timbre === 'spur-jingle') {
    return 'jingle'
  }
  return sound?.timbre === 'spur-rattle' ? 'rattle' : null
}

export const soundUrl = (def: SoundDef) => `${SFX_DIR}/${def.file}.m4a`

/** Fetch and decode every Frontier sound ahead of joining (the engine reuses the same assets). */
export function preloadFrontierAudio(game: GameApplication): Promise<void> {
  return Promise.all(
    Object.values(SOUNDS).map((def) => game.loadAudio(soundUrl(def)).catch(() => null)),
  ).then(() => undefined)
}
