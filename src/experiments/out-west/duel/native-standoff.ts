import { actSong, winStreak } from '../audio/catalog.ts'
import { shotVisuals } from '../client/shot-visuals.ts'
import { FEEL } from '../data/feel.ts'
import { RIFLEMAN } from '../data/outlaws.ts'
import { haptic } from '../platform/haptics.ts'
import { say, TALKER_GAP } from './chatter.ts'
import type { DuelActor } from './native-actor.ts'
import { clamp01, V } from './native-camera.ts'
import type { NativeDirector } from './native-director.ts'
import {
  backToBackShot,
  callShot,
  clockInsert,
  headOf,
  otsShot,
  posterShot,
  standoffShot,
  walkShot,
} from './native-framing.ts'

import {
  AMB,
  ambience,
  BACK_TO_BACK_Z,
  boss,
  duckForStandoff,
  flash,
  killFrame,
  Moments,
  pos,
  reduced,
  turnTo,
} from './native-moments.ts'
import { backShotByEnemy, tickBackShot } from './native-outcome.ts'

const STALL_LINES = [
  'You plannin’ on walkin’ today?',
  'I ain’t got all day, friend.',
  'My grandma walks faster.',
  'Scared?',
]
const NUMBERS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]
const PLAYER_DRAW_S = 0.3
const GLINT_MARK_S = 0.3

/** The walk, the standoff and the call, restored from the original engine. */

// --------------------------------------------------------------------------------- the stage

/** Music, voice and the poster for this outlaw; call before the attempt is counted. */
export function setStage(d: NativeDirector): void {
  const a = d.c.audio
  const data = d.c.save
  if (d.level >= 11) {
    a.preloadSong('boss')
  }
  a.playSong(actSong(d.level, d.outlaw.day, winStreak(d.level, data.attempts, data.best)))
  a.loadVoice(d.outlaw.name)
  d.arenas.stampPoster(d.level, null)
}

/** Fresh per-attempt state and both men on their marks. */
function restage(d: NativeDirector): void {
  const old = d.m
  d.m = new Moments()
  d.m.ambLevel = old.ambLevel
  d.m.ambRamp = old.ambRamp
  d.m.sat = old.sat
  if (old.flash > 0) {
    d.game.app.scene.exposure = old.baseExposure
  }
  killFrame(d, false)
  d.c.hud.letterbox(false)
  d.c.hud.marker(null, null)
  d.c.hud.irisRed(false)
  if (d.player) {
    d.player.root.enabled = true
  }
  if (boss(d)) {
    // face to face under the clock tower; everyone else back to back
    const face = d.arenas.clockFace()
    const z = face ? face.z : 60.8
    d.player?.place(0, 0, z - 16.8)
    d.player?.face(0)
    d.enemy?.place(0, 0, z - 7.8)
    d.enemy?.face(180)
  } else {
    d.player?.place(0, 0, -BACK_TO_BACK_Z)
    d.player?.face(180)
    d.enemy?.place(0, 0, BACK_TO_BACK_Z)
    d.enemy?.face(0)
  }
}

/** The boss's second phase again after a loss: both men back on their feet where they stand. */
export function standBackUp(d: NativeDirector): void {
  if (d.phase === 'coward') {
    d.arenas.stampPoster(d.level, null)
  }
  restage(d)
  d.m.satTarget = 1
  d.player?.play('Idle', 0.1)
  d.enemy?.play('Idle', 0.1)
}

/** The poster beat that opens a new outlaw. */
export function enterPoster(d: NativeDirector): void {
  restage(d)
  d.enter('poster')
  d.c.audio.musicLevel(0, 0.4)
  d.c.audio.musicLowpass(18_000, 0.3)
  d.c.hud.whipPan()
  d.c.audio.play('whip', { gain: 0.7 })
  if (d.c.save.legend && d.level === 0) {
    d.c.hud.showCard({
      kind: 'info',
      title: 'LEGEND MODE',
      big: '2019',
      sub: 'The original 2019 timings.',
      hint: '',
    })
  }
  posterShot(d)
  printPortrait(d)
}

/** His mugshot onto the poster, as soon as his model stands on the stage (once per level). */
export function printPortrait(d: NativeDirector): void {
  const level = d.level
  if (d.m.printed === level) {
    return
  }
  void d.portraits.print(level, d.enemy).then((print) => {
    if (print && d.m.printed !== level) {
      d.m.printed = level
      d.arenas.posterPortrait(level, print)
    }
  })
}

/** Both men cock their guns; the walk (or the boss's clock) follows. */
export function enterCock(d: NativeDirector): void {
  restage(d)
  d.enter('cock')
  d.player?.play('Idle', 0.1)
  d.enemy?.play('Idle', 0.1)
  d.c.hud.hideCard()
  d.c.hud.setPips(0, false)
  d.c.audio.play('cocking', { gain: 0.9 })
  d.c.audio.musicLevel(0, 0.3)
  d.c.audio.musicLowpass(18_000, 0.3)
  ambience(d, 1, 0.6)
  if (boss(d)) {
    otsShot(d, false)
  } else {
    backToBackShot(d)
  }
  if (d.level === 0 && (d.c.save.attempts[0] ?? 0) <= 1) {
    d.c.hud.fake(
      d.c.input.touch
        ? '[hold to walk · tap only after the bell]'
        : '[hold W to walk · fire only after the bell]',
      3200,
    )
  }
}

export function tickCock(d: NativeDirector): void {
  if (!d.m.enemyCocked && d.phaseT >= FEEL.enemyCockDelay) {
    d.m.enemyCocked = true
    d.c.audio.play('cocking', { gain: 0.8, pos: pos(d.enemy), rate: 0.95 })
  }
  if (d.phaseT >= FEEL.inputEnableDelay) {
    if (boss(d)) {
      d.wait()
    } else {
      enterWalk(d)
    }
  }
}

// ---------------------------------------------------------------------------------- the walk

export function enterWalk(d: NativeDirector): void {
  d.enter('walk')
  d.walkLines = 0
  d.c.hud.hideCard()
  d.c.hud.setPips(0, true)
  d.c.audio.musicSection('duel')
  d.c.audio.musicLevel(FEEL.walkDuckDb, 0.8)
  d.c.audio.musicLowpass(FEEL.walkLowpass, 0.8)
  walkShot(d)
}

function paceFx(d: NativeDirector): void {
  const a = d.c.audio
  const rng = Math.random
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
      pos: pos(e),
    })
    d.dust.emit(V(0, 0.05, pos(e).z), 6, { speed: 0.6, size: 0.12, life: 1, alpha: 0.35 })
  }
  d.dust.emit(V(0, 0.05, pos(d.player).z), 8, { speed: 0.7, size: 0.12, life: 1.1, alpha: 0.4 })
}

/** The pace an outlaw's second (and last) walk line lands on: past halfway, clear of the turn. */
const beatPace = (d: NativeDirector): number => Math.max(2, Math.ceil(d.targetPaces * 0.6))

function walkSay(d: NativeDirector, text: string, ms: number, gap?: number): void {
  if (say(d, d.outlaw.name, text, gap === undefined ? { ms } : { ms, gap })) {
    d.walkLines++
  }
}

/** What he says on the walk: an opener, one line at the beat, the talker and counter per pace. */
function walkLine(d: NativeDirector): void {
  const o = d.outlaw
  const n = d.m.paces
  if (n >= d.targetPaces || o.lines.length === 0) {
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
      if (n === 1 || (d.walkLines === 1 && n >= beatPace(d) && Math.random() < 0.5)) {
        walkSay(d, line(Math.floor(Math.random() * o.lines.length)) || '*hic*', 1300)
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
  if (n === 1 && d.walkLines === 0) {
    walkSay(d, line(0), 1800)
  } else if (n === beatPace(d) && d.walkLines === 1 && o.lines.length > 1) {
    walkSay(d, line(1), 1800)
  }
}

function locomote(actor: DuelActor | null, speed: number): void {
  if (!actor) {
    return
  }
  if (speed > 0.05) {
    actor.play('Walk', 0.2)
    actor.speed((actor.walkDuration / 2 / FEEL.paceSeconds) * Math.max(0.35, speed))
  } else {
    actor.play('Idle', 0.25)
  }
}

export function tickWalk(d: NativeDirector, dt: number): void {
  const m = d.m
  if (m.backShotAt > 0) {
    tickBackShot(d, dt)
    return
  }
  const want = d.c.input.walking ? 1 : 0
  const rate = dt / FEEL.walkRamp
  d.speed = want > d.speed ? Math.min(1, d.speed + rate) : Math.max(0, d.speed - rate)
  const p = d.player
  const e = d.enemy
  locomote(p, d.speed)
  locomote(e, d.speed)
  const stride = p?.paceLength ?? 0.66
  m.pDist += (d.speed * stride * dt) / FEEL.paceSeconds
  m.eDist += (d.speed * (e?.paceLength ?? stride) * dt) / FEEL.paceSeconds
  p?.place(0, 0, -BACK_TO_BACK_Z - m.pDist)
  e?.place(0, 0, BACK_TO_BACK_Z + m.eDist)
  d.walked += (d.speed * dt) / FEEL.paceSeconds
  while (m.paces < Math.floor(d.walked) && d.phase === 'walk') {
    m.paces++
    d.c.hud.setPips(m.paces, true)
    paceFx(d)
    walkLine(d)
    if (m.paces >= d.targetPaces) {
      enterTurn(d)
      return
    }
  }
  d.stalled = d.speed < 0.05 ? d.stalled + dt : 0
  if (d.stalled > FEEL.stallHeckle && !d.stallHeckled) {
    d.stallHeckled = true
    say(d, d.outlaw.name, STALL_LINES[Math.floor(Math.random() * STALL_LINES.length)] ?? 'Walk.')
  }
  if (d.stalled > FEEL.stallBackShot) {
    backShotByEnemy(d)
  }
}

/** Pace N: both men plant their feet, backs still turned. Nobody turns until the bell. */
function enterTurn(d: NativeDirector): void {
  d.enter('turn')
  d.speed = 0
  d.c.hud.setPips(d.m.paces, false)
  d.player?.play('Idle', 0.2)
  d.enemy?.play('Idle', 0.2)
  duckForStandoff(d, 0.9)
  ambience(d, AMB.turn, 0.9)
  standoffShot(d, false, 1.2)
}

// ------------------------------------------------------------------------------ the standoff

/** The wait opens: the heartbeat starts, the score ducks, the camera begins its slow push. */
export function enterWait(d: NativeDirector): void {
  const m = d.m
  m.waitStart = performance.now()
  m.ecuDone = false
  m.nextBeat = m.waitStart + 60_000 / FEEL.heartStartBpm
  m.hisMs = null
  m.glintFired = false
  d.c.audio.heartbeat(FEEL.heartStartBpm)
  duckForStandoff(d, 0.5)
  ambience(d, AMB.wait, 0.6)
  if (boss(d)) {
    d.player?.face(0)
    d.enemy?.face(180)
    otsShot(d, true, 0.4)
  } else {
    standoffShot(d, true, 0.4)
  }
  d.c.hud.letterbox(false)
}

export function tickWait(d: NativeDirector, now: number): void {
  const m = d.m
  const sec = (now - m.waitStart) / 1000
  const rampPerSec = boss(d) && d.bossPhase === 1 ? 4 : FEEL.heartBpmPerSecond
  const bpm = Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + rampPerSec * sec)
  d.c.audio.heartbeat(bpm)
  if (now >= m.nextBeat) {
    haptic('beat')
    m.nextBeat = now + 60_000 / bpm
  }
  m.vignette = clamp01(sec / (boss(d) && d.bossPhase === 1 ? 6 : 2))
  const callAt = d.clock.callAt()
  if (!m.ecuDone && sec >= 2 && (callAt === null || callAt - now > 900)) {
    m.ecuDone = true
    if (!reduced(d)) {
      d.c.hud.letterbox(true)
    }
  }
  if (d.rig.name === 'clock' && d.realTime >= d.clockInsertUntil) {
    otsShot(d, true, 0)
  }
}

/** A clock strike in the boss's count (6..11); the twelfth is the call itself. */
export function strike(d: NativeDirector, n: number): void {
  d.arenas.toll()
  d.c.audio.play('bell', { gain: 0.8, reverb: 0.5 })
  d.c.hud.fake(`[bell strikes ${NUMBERS[n - 1] ?? n}]`, 900)
  if (n === 6) {
    clockInsert(d, 1.1)
  } else if (n === 11) {
    clockInsert(d, 0.8)
  }
}

/** The yaw an actor faces, degrees (Euler readback flips past ±90°, so read the forward). */
function enemyDrawSecs(d: NativeDirector): number {
  const first = d.plan?.shots.find((shot) => shot.who === 0)
  const ms = first ? first.t - d.callTime : d.outlaw.draw
  return Math.min(0.5, Math.max(0.24, (ms * 0.85) / 1000))
}

/** The bell: both men turn and draw on it in the same frame; the camera eases in. */
export function callMoment(d: NativeDirector): void {
  d.c.hud.letterbox(false)
  if (!d.dailyModifiers.includes('no-bell')) {
    flash(d, 0.5)
  }
  if (boss(d) && d.bossPhase === 2) {
    d.c.audio.play('shout', { gain: 1, rate: 0.7, pos: pos(d.enemy) })
    d.c.hud.fake('[he screams]', FEEL.callCaptionMs)
  }
  if (!boss(d)) {
    turnTo(d, d.player, 0, PLAYER_DRAW_S)
    turnTo(d, d.enemy, 180, enemyDrawSecs(d))
  }
  if (d.outlaw.gimmick === 'shaky' && d.enemy) {
    // the shaky man's nerves: his hat jumps off his head as he spins
    const away = pos(d.enemy).sub(pos(d.player))
    away.y = 0
    away.normalize()
    d.debris.drop(d.enemy, 'hat', away, false)
  }
  callShot(d)
}

export function tickCall(d: NativeDirector, now: number): void {
  const r = d.rifleman
  if (r && d.riflemanAlive && !d.m.glintFired && now - d.callTime >= RIFLEMAN.glintAt) {
    d.m.glintFired = true
    d.m.glintMarkUntil = d.realTime + GLINT_MARK_S
    shotVisuals(d.game, true).impact(headOf(r).add(V(-0.35, -0.02, 0)), false)
    d.c.hud.fake('[a glint on the saloon roof]')
  }
  marker(d)
}

function marker(d: NativeDirector): void {
  const r = d.rifleman
  const lens = d.game.camera.camera
  if (r && d.riflemanAlive && d.realTime < d.m.glintMarkUntil && lens) {
    const s = lens.worldToScreen(headOf(r).add(V(-0.35, -0.02, 0)))
    const canvas = d.game.app.graphicsDevice.canvas
    const rect = canvas.getBoundingClientRect()
    d.c.hud.marker(
      rect.left + (s.x * rect.width) / canvas.width,
      rect.top + (s.y * rect.height) / canvas.height,
    )
  } else {
    d.c.hud.marker(null, null)
  }
}
