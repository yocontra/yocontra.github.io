import type { Vector3 } from 'three'
import { FEEL } from '../data/feel.ts'
import { clamp01 } from '../scene/camera.ts'
import { between, type DuelState, V } from './state.ts'

/** Wind and crickets: started once, on the first press. */
export function startAmbience(s: DuelState): void {
  const a = s.c.audio
  s.windLoop ??= a.loop('wind', 0.35)
  s.cricketLoop ??= a.loop('crickets', 0)
}

const AMBIENT_PHASES = new Set(['walk', 'poster', 'intro'])

export function tickAmbience(s: DuelState, dt: number): void {
  const c = s.c
  const night = clamp01((c.world.day - 0.6) / 0.25)
  s.cricketLoop?.set(night * 0.35 * (s.phase === 'wait' ? 0.6 : 1), 1)
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
  if (s.outlaw.gimmick === 'windy' && (s.phase === 'walk' || s.phase === 'wait')) {
    s.windLoop?.set(0.25 + s.wind * 0.15, 0.4)
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
