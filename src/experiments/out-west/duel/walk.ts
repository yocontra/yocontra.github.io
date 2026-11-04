import { FEEL } from '../data/feel.ts'
import { clamp01 } from '../scene/camera.ts'
import { say, TALKER_GAP } from './chatter.ts'
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
  d.walkLines = 0
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
    say(d, d.outlaw.name, STALL_LINES[Math.floor(rng() * STALL_LINES.length)] ?? 'Walk.')
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

/** The pace an outlaw's second (and last) walk line lands on: past halfway, clear of the turn. */
const beatPace = (d: Director): number => Math.max(2, Math.ceil(d.target * 0.6))

/** One walk line from him, if the cadence allows; counts toward his two. */
function walkSay(d: Director, text: string, ms: number, gap?: number): void {
  if (say(d, d.outlaw.name, text, gap === undefined ? { ms } : { ms, gap })) {
    d.walkLines++
  }
}

/**
 * What he says on the walk. Everyone opens with at most one line on the first pace and may add one
 * more at the beat past halfway; nobody speaks on the last pace (the turn is silent). The talker
 * heckles and the counter miscounts on whichever pace the floor is free (every 2.5 s or more, so one to three
 * lines a walk, each still naming its own pace); the drunk hiccups once more if the dice say so;
 * the whistler's dirge is captioned once.
 */
function walkLine(d: Director): void {
  const o = d.outlaw
  const n = d.paces
  if (n >= d.target || o.lines.length === 0) {
    return
  }
  const line = (i: number): string => o.lines[i % o.lines.length] ?? ''
  switch (o.gimmick) {
    case 'talker':
      walkSay(d, line(n - 1), 1600, TALKER_GAP)
      return
    case 'counter':
      walkSay(d, line(n - 1), 1100, TALKER_GAP)
      return
    case 'drunk':
      if (n === 1 || (d.walkLines === 1 && n >= beatPace(d) && rng() < 0.5)) {
        walkSay(d, line(Math.floor(rng() * o.lines.length)) || '*hic*', 1300)
      }
      return
    case 'whistler':
      if (n === 1) {
        d.c.hud.fake('[he whistles a dirge]', 2000)
      } else if (n === beatPace(d) && d.walkLines === 0) {
        walkSay(d, line(0), 1800)
      }
      return
    default:
      break
  }
  // everyone else: the opener on the first pace, a second line (if he has one) at the beat
  if (n === 1 && d.walkLines === 0) {
    walkSay(d, line(0), 1800)
  } else if (n === beatPace(d) && d.walkLines === 1 && o.lines.length > 1) {
    walkSay(d, line(1), 1800)
  }
}

function onPace(d: Director): void {
  if (d.phase !== 'walk') {
    return
  }
  d.paces++
  d.c.hud.setPips(d.paces, true)
  paceFx(d)
  walkLine(d)
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
