import type { Vector3 } from 'three'
import { FEEL } from '../data/feel.ts'
import { clamp01 } from '../scene/camera.ts'
import { between, type DuelState, V } from './state.ts'

/**
 * Levels for the time-of-day bed (`AudioEngine.setTimeOfDay`), where 1 is the resting bed. The
 * standoff hush (×0.6 while waiting) applies on top, so `wait` leaves the wind where the standoff
 * has always had it: well under the bell.
 */
export const AMB = {
  /** Backs planted after the last pace. */
  turn: 0.4,
  /** The wait, before the ×0.6 standoff hush. */
  wait: 0.57,
  /** The boss's clock. */
  bossClock: 0.29,
  /** A gust fake-out. */
  gust: 1.4,
  /** The town holds its breath (a back-shot). */
  hush: 0.14,
} as const

/** The standoff hush: the bed drops while the street waits for the call. */
const WAIT_HUSH = 0.6
/** The windy outlaw's bed follows his gusts (his wind is 0.35 at rest). */
const windyLevel = (wind: number): number => (0.25 + wind * 0.15) / 0.35
const isWindy = (s: DuelState): boolean =>
  s.outlaw.gimmick === 'windy' && (s.phase === 'walk' || s.phase === 'wait')

/** Duck the score for the standoff: gently, and deeper for the tension drones (`FEEL`). */
export function duckForStandoff(s: DuelState, ramp: number): void {
  const a = s.c.audio
  a.musicLowpass(FEEL.waitLowpass, ramp)
  a.musicLevel(a.currentSong === 'tension' ? FEEL.tensionWaitDuckDb : FEEL.waitDuckDb, ramp)
}

/** Set where the bed is heading (1 = resting) and how fast, in seconds. */
export function ambience(s: DuelState, level: number, ramp: number): void {
  s.ambLevel = level
  s.ambRamp = ramp
}

/** The bed's level right now: the moment's level, the windy outlaw's gusts and the standoff hush. */
export function bedLevel(s: DuelState): number {
  return (isWindy(s) ? windyLevel(s.wind) : s.ambLevel) * (s.phase === 'wait' ? WAIT_HUSH : 1)
}

/** The time-of-day bed (wind by day, dusk and night, crickets after dark), on the first press. */
export function startAmbience(s: DuelState): void {
  ambience(s, 1, 1.5)
  s.c.audio.setTimeOfDay(s.c.world.day, bedLevel(s), s.ambRamp)
}

const AMBIENT_PHASES = new Set(['walk', 'poster', 'intro'])

export function tickAmbience(s: DuelState, dt: number): void {
  const c = s.c
  const night = clamp01((c.world.day - 0.6) / 0.25)
  c.audio.setTimeOfDay(c.world.day, bedLevel(s), isWindy(s) ? 0.4 : s.ambRamp)
  s.ambT -= dt
  if (s.ambT <= 0 && AMBIENT_PHASES.has(s.phase)) {
    s.ambT = between(9, 18)
    if (night < 0.5) {
      c.audio.play('hawk', {
        gain: 0.35,
        pos: V(between(-40, 40), 30, between(-60, 60)),
        reverb: 0.3,
      })
    } else {
      c.audio.play('dog', { gain: 0.3, pos: V(between(-60, 60), 1, between(-60, 60)), reverb: 0.6 })
    }
  }
}

const WINDY_PHASES = new Set(['walk', 'wait', 'call'])

/** Grade, bloom, grain, vignette, lens and dust follow the time of day and the moment. */
export function tickPresentation(s: DuelState, realDt: number): void {
  const c = s.c
  const r = c.renderer
  const p = c.world.preset
  s.sat += (s.satTarget - s.sat) * Math.min(1, realDt * 3)
  r.grade.u('saturation').value = p.saturation * s.sat
  r.grade.u('contrast').value = p.contrast
  r.grade.u('lift').value = p.lift
  r.grade.u('exposure').value = p.exposure
  ;(r.grade.u('shadowTint').value as Vector3).set(...p.shadowTint)
  ;(r.grade.u('highTint').value as Vector3).set(...p.highTint)
  const f = r.grade.u('flash')
  f.value = Math.max(0, (f.value as number) - realDt * 30)
  r.bloom.intensity = p.bloom
  r.noise.blendMode.opacity.value = p.grain
  r.vignette.darkness = s.reduced ? FEEL.vignetteBase : s.vignette
  if (s.phase !== 'wait' && s.phase !== 'bossClock') {
    s.vignette += (FEEL.vignetteBase - s.vignette) * Math.min(1, realDt * 2)
  }
  s.ca = Math.max(0, s.ca - realDt * (0.012 / 0.2))
  r.setLens(s.ca, p.shimmer, s.satTarget < 1 ? clamp01(s.phaseT) * 0.6 : 0)
  const windy = s.outlaw.gimmick === 'windy'
  c.dust.wind = 0.6 + (windy ? s.wind : 0.35) * 1.6
  if (!(windy && WINDY_PHASES.has(s.phase))) {
    s.wind += (0.35 - s.wind) * Math.min(1, realDt)
  }
  // muzzle light decays in game time, so it lingers through the slow-mo
  c.world.flashLight.intensity *= Math.exp(-realDt * Math.max(s.timeScale, 0.05) * 22)
}
