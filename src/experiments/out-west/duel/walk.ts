import { FEEL } from '../data/feel.ts'
import { clamp01 } from '../scene/camera.ts'
import { throwCard } from './cues.ts'
import { backShotByEnemy } from './defeat.ts'
import type { Director } from './director.ts'
import { standoffShot, walkShot } from './framing.ts'
import { AMB, ambience, duckForStandoff } from './present.ts'
import { rng, V } from './state.ts'

const STALL_LINES = [
  'You plannin’ on walkin’ today?',
  'I ain’t got all day, friend.',
  'My grandma walks faster.',
  'Scared?',
]

export function enterWalk(d: Director): void {
  d.enter('walk')
  d.c.hud.setPips(0, true)
  // the walk and the standoff play over low drones, clear of the bell's register
  d.c.audio.playSong('tension')
  d.c.audio.musicLevel(0, 0.6)
  walkShot(d)
  if (d.outlaw.gimmick === 'windy') {
    d.wind = 0.4
  }
}

function countPaces(d: Director): void {
  const p = d.player
  const wt = p.walkTime
  if (d.speed > 0.05) {
    for (const hs of p.heelStrikes) {
      const crossed =
        d.lastWalkTime <= wt ? hs > d.lastWalkTime && hs <= wt : hs > d.lastWalkTime || hs <= wt
      if (crossed) {
        onPace(d)
      }
    }
  }
  d.lastWalkTime = wt
}

function tickStall(d: Director, dt: number): boolean {
  d.stall = d.speed < 0.05 ? d.stall + dt : 0
  if (d.stall > FEEL.stallHeckle && !d.stallHeckled) {
    d.stallHeckled = true
    d.c.hud.line(d.outlaw.name, STALL_LINES[Math.floor(rng() * STALL_LINES.length)] ?? 'Walk.')
  }
  if (d.stall > FEEL.stallBackShot) {
    backShotByEnemy(d)
    return true
  }
  return false
}

export function tickWalk(d: Director, dt: number): void {
  const c = d.c
  const o = d.outlaw
  const want = c.input.walking ? 1 : 0
  const rate = dt / FEEL.walkRamp
  d.speed = want > d.speed ? Math.min(1, d.speed + rate) : Math.max(0, d.speed - rate)
  const p = d.player
  p.locomote(d.speed, p.walkDuration / 2 / FEEL.paceSeconds)
  d.pDist += (d.speed * p.paceLength * dt) / FEEL.paceSeconds
  p.root.position.z = -0.28 - d.pDist
  countPaces(d)
  if (d.phase !== 'walk') {
    return
  }
  const e = d.enemy
  if (e) {
    e.locomote(d.speed, e.walkDuration / 2 / FEEL.paceSeconds)
    d.eDist += (d.speed * e.paceLength * dt) / FEEL.paceSeconds
    e.root.position.z = 0.28 + d.eDist
  }
  if (tickStall(d, dt)) {
    return
  }
  if (o.gimmick === 'windy') {
    d.wind = Math.min(2.6, d.wind + dt * 0.25)
    c.world.windyFog(clamp01((d.wind - 0.4) / 2.2))
  }
  if (o.gimmick === 'cards') {
    d.cardT -= dt
    if (d.cardT <= 0) {
      d.cardT = 0.4 + rng() * 0.6
      throwCard(d)
    }
  }
}

function paceFx(d: Director): void {
  const c = d.c
  const a = c.audio
  a.play('spursteps', {
    offset: Math.floor(rng() * 8),
    duration: 0.7,
    gain: 0.55,
    rate: 0.95 + rng() * 0.1,
  })
  a.play('dirtsteps', { offset: Math.floor(rng() * 6) * 0.6, duration: 0.5, gain: 0.45 })
  const e = d.enemy
  if (e) {
    a.play('spursteps', {
      offset: Math.floor(rng() * 8),
      duration: 0.7,
      gain: 0.45,
      when: a.now + FEEL.enemyStepOffset,
      pos: e.root.position.clone(),
    })
    c.puffs.emit(V(0, 0.05, e.root.position.z), 6, { speed: 0.6, size: 0.12, life: 1, alpha: 0.35 })
  }
  c.puffs.emit(V(0, 0.05, d.player.root.position.z), 8, {
    speed: 0.7,
    size: 0.12,
    life: 1.1,
    alpha: 0.4,
  })
}

/** Per-pace gimmicks: the talker heckles, the counter counts (wrong), the drunk hiccups. */
function paceGimmick(d: Director): void {
  const c = d.c
  const o = d.outlaw
  const line = (i: number): string => o.lines[i % o.lines.length] ?? ''
  switch (o.gimmick) {
    case 'talker':
      c.hud.line(o.name, line(d.paces - 1), 1100)
      break
    case 'counter':
      c.hud.line(o.name, line(d.paces - 1), 900)
      break
    case 'drunk':
      if (rng() < 0.3) {
        c.hud.line(o.name, line(Math.floor(rng() * o.lines.length)) || '*hic*', 1000)
      }
      break
    case 'impatient':
      if (d.paces === 2) {
        c.hud.line(o.name, line(0), 1400)
      }
      break
    case 'whistler':
      if (d.paces % 2 === 1) {
        c.hud.fake('[he whistles a dirge]')
      }
      break
    default:
      break
  }
}

function onPace(d: Director): void {
  if (d.phase !== 'walk') {
    return
  }
  d.paces++
  d.c.hud.setPips(d.paces, true)
  paceFx(d)
  paceGimmick(d)
  if (d.paces >= d.target) {
    enterTurn(d)
  }
}

/**
 * Pace N: both men plant their feet with their backs to each other. Nobody
 * turns until the bell (the turn is the call).
 */
function enterTurn(d: Director): void {
  const c = d.c
  d.enter('turn')
  d.speed = 0
  c.hud.setPips(d.paces, false)
  d.player.stopWalk(0.2)
  d.enemy?.stopWalk(0.2)
  // music ducks gently (still clearly there), wind drops
  duckForStandoff(d, 0.9)
  ambience(d, AMB.turn, 0.9)
  standoffShot(d, false, 1.2)
}

export function tickTurn(d: Director): void {
  if (d.phaseT >= FEEL.turnDuration) {
    d.player.play('Idle', 0.25)
    d.enemy?.play('Idle', 0.25)
    d.enterWait(false)
  }
}
