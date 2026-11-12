import { math, type Vec3 } from 'playcanvas'
import { shotVisuals } from '../client/shot-visuals.ts'
import { FEEL } from '../data/feel.ts'
import { MEDAL_MS, tierFor, tierName } from '../data/medals.ts'
import { gradeFor, TOUCH_ALLOWANCE_MS } from '../data/outlaws.ts'
import { haptic } from '../platform/haptics.ts'
import { say } from './chatter.ts'
import type { DuelActor } from './native-actor.ts'
import { clamp01, V } from './native-camera.ts'
import type { NativeDirector } from './native-director.ts'
import { cowardShot, deathShot, killShot, secondTargetShot } from './native-framing.ts'

import {
  AMB,
  ambience,
  boss,
  dieInStyle,
  flash,
  killFrame,
  type PendingCard,
  pos,
  reduced,
  turnTo,
} from './native-moments.ts'

const SPIN_AT = 1.35
const LOSE_CARD_S = 0.45
const BACKSHOT_TURN_S = 0.32
const BACKSHOT_HIT_S = 0.34
const COWARD_DRAW_S = 0.26

/** The shots and the outcomes (kill cam, death, back-shot, boss wound), restored from the original engine. */

// --------------------------------------------------------------------------------- the shots

/** Your shot: weight in the lens, the report's room and your breath behind it. */
export function playerFireFx(d: NativeDirector): void {
  d.c.audio.play('fire', { gain: 1.2, reverb: 0.6 })
  d.c.audio.effort('draw')
  d.rig.addTrauma(FEEL.shake.own)
  haptic('shot')
}

/** His shot misses: a whizz past your ear, a ricochet, dirt kicked up by your boots. */
export function missFx(d: NativeDirector): void {
  const a = d.c.audio
  const P = pos(d.player)
  const r = (n: number) => (Math.random() * 2 - 1) * n
  a.whizz(Math.random() < 0.5 ? -0.7 : 0.7)
  a.effort('flinch', 0.12)
  a.play('ricochet', {
    offset: Math.floor(Math.random() * 4),
    duration: 0.8,
    gain: 0.8,
    when: a.now + 0.08,
    pos: { x: P.x + r(2), y: 0, z: P.z - 1 - Math.random() * 2 },
  })
  const hit = V(P.x + r(1.2), 0.05, P.z - 0.8 - Math.random() * 1.7)
  d.dust.emit(hit, 30, { speed: 1.6, size: 0.1, life: 1.2, alpha: 0.5, up: 1.4 })
  shotVisuals(d.game, true).impact(hit, false)
  d.rig.addTrauma(FEEL.shake.whizz)
  d.player?.play('Flinch', 0.05)
}

/** He goes down: impact at the chest, and the fall timed on his own clock. */
export function killEnemyAnim(d: NativeDirector, victim: DuelActor | null): void {
  if (!victim) {
    return
  }
  const from = pos(d.player)
  const at = pos(victim)
  const away = V(at.x - from.x, 0, at.z - from.z).normalize()
  hitFx(d, at.add(V(0, 1.25, 0)).sub(away.clone().mulScalar(0.12)), away, true)
  dieInStyle(d, victim, gradeFor(d.reactionMs ?? 999, d.secondChance))
}

/** A round lands on a man: dust beaten out of his coat along the shot, cloth, a spark. No blood. */
export function hitFx(d: NativeDirector, at: Vec3, away: Vec3, lethal: boolean): void {
  shotVisuals(d.game, true).impact(at, true)
  d.dust.emit(at, 26, {
    speed: 0.4,
    size: 0.08,
    life: 1.1,
    alpha: 0.32,
    up: 0.12,
    dir: away.clone().mulScalar(1.6),
    tint: [0.62, 0.55, 0.46],
  })
  d.dust.emit(at, 10, {
    speed: 0.6,
    size: 0.06,
    life: 0.8,
    alpha: 0.9,
    up: -0.6,
    dir: away.clone().mulScalar(1.4),
    tint: [0.29, 0.24, 0.2],
  })
  d.rig.addTrauma(lethal ? 0.22 : 0.16)
}

/** The rooftop rifleman tumbles off the saloon. */
export function killRifleman(d: NativeDirector): void {
  const r = d.rifleman
  if (!r) {
    return
  }
  d.m.faller = { actor: r, v: V(-2.2, 2.5, 0) }
  d.c.audio.play('bodyfall', { gain: 0.9, pos: pos(r), when: d.c.audio.now + 0.9 })
}

/** One gun is down: point the lens at the one still standing. */
export function focusRemaining(d: NativeDirector, who: 0 | 1): void {
  secondTargetShot(d, who)
  if (who === 1 && d.riflemanAlive) {
    d.m.glintFired = true
    d.m.glintMarkUntil = d.realTime + 3
    d.c.hud.fake('[the rifleman on the roof]', 2200)
  } else {
    d.c.hud.fake('[he’s still standing]', 2200)
  }
}

// ------------------------------------------------------------------------------- the outcomes

/** Time scale through an outcome: 1x lead, slow segment, eased ramp back to 1x. */
export function slowMo(k: number, lead: number, slow: number, scale: number): number {
  if (k < lead) {
    return 1
  }
  if (k < lead + slow) {
    return scale
  }
  const u = clamp01((k - lead - slow) / FEEL.rampBack)
  return scale + (1 - scale) * u * u * (3 - 2 * u)
}

/** You won the draw: a 70 ms hitstop, the red frame, the kill cam, the card when it settles. */
export function beginWin(d: NativeDirector, card: PendingCard): void {
  const m = d.m
  m.card = card
  m.cardShown = false
  m.killCamStarted = false
  m.swelled = false
  m.timeScale = 0
  d.killDur = reduced(d) ? FEEL.killCamSecondsReduced : FEEL.killCamSeconds
  if (boss(d)) {
    d.killDur = reduced(d) ? 0.8 : FEEL.bossKillSeconds
    m.nextToll = 0.5
  }
  d.killOrbit = boss(d) ? 4 * math.DEG_TO_RAD : 0
  // practice: when he'd have drawn (the two-gun man's sure miss doesn't count)
  const due = d.plan?.shots.find((s) => s.who === 0 && (s.hit || d.outlaw.gimmick !== 'two-guns'))
  if (m.hisMs === null && due && d.callTime > 0) {
    m.hisMs = due.t - d.callTime
  }
  d.c.audio.heartbeat(0)
  d.c.hud.clearCall()
  d.c.hud.clearCaptions()
  d.c.hud.letterbox(false)
  if (!d.c.audio.voice(d.outlaw.name, 'death', 0.35)) {
    d.c.audio.play('shout', { gain: 0.9, when: d.c.audio.now + 0.35 })
  }
  d.arenas.stampPoster(d.level, 'dead')
  if (!m.dying && d.enemy) {
    killEnemyAnim(d, d.enemy)
  }
}

export function startKillCam(d: NativeDirector): void {
  d.m.killCamStarted = true
  if (reduced(d)) {
    flash(d, 0.25)
  } else {
    d.m.killFrames = FEEL.redFrames + 1
    killFrame(d, true)
  }
  killShot(d)
  if (d.player) {
    const muzzle = d.player.muzzle()
    if (muzzle) {
      shotVisuals(d.game, true).muzzle(muzzle.position, 0.11, muzzle.direction)
    }
  }
}

export function tickWin(d: NativeDirector, realDt: number): void {
  const m = d.m
  const t = d.phaseT
  const hit = FEEL.hitstopMs / 1000
  if (t < hit) {
    m.timeScale = 0
    return
  }
  if (!m.killCamStarted) {
    startKillCam(d)
  }
  const k = t - hit
  m.timeScale = slowMo(
    k,
    FEEL.killCamLead,
    d.killDur,
    reduced(d) ? FEEL.killCamScaleReduced : FEEL.killCamScale,
  )
  if (!m.swelled && k > 0.4) {
    m.swelled = true
    d.c.audio.musicLowpass(18_000, 0.4)
    d.c.audio.musicLevel(0, 0.6)
    d.c.audio.playVictory(gradeFor(d.reactionMs ?? 0, d.secondChance))
  }
  if (t >= SPIN_AT && t - realDt < SPIN_AT) {
    d.player?.play('Spin', 0.08)
  }
  const layer = d.player?.model.anim?.baseLayer
  if (layer?.activeState.startsWith('Spin') && layer.activeStateProgress >= 0.98) {
    d.player?.play('Idle', 0.3)
  }
  let done = t >= FEEL.resultAt + FEEL.resultFor
  if (boss(d)) {
    if (k > m.nextToll && m.bells < 12) {
      m.bells++
      m.nextToll = k + 0.9
      d.arenas.toll()
      d.c.audio.play('bell', { gain: 0.8, reverb: 0.6 })
    }
    done = m.bells >= 6 && k > d.killDur + 1 && done
  }
  if (!m.cardShown && t >= FEEL.resultAt) {
    m.cardShown = true
    m.card?.show()
  }
  if (done) {
    d.advance()
  }
}

/** The win card's medal line ("Silver medal. Gold under 285 ms."); empty where medals don't count. */
export function medalNote(d: NativeDirector, r: number): string {
  const t = MEDAL_MS[d.level]
  if (!t || d.c.save.legend || d.daily || d.remote) {
    return ''
  }
  const touch = d.c.input.touch && !d.ranked
  const tier = tierFor(d.level, r, touch)
  const name = tierName(tier)
  if (!name) {
    return ''
  }
  const extra = touch ? TOUCH_ALLOWANCE_MS : 0
  const next = (tier === 1 ? t[1] : t[2]) + extra
  const label = `${name[0]?.toUpperCase() ?? ''}${name.slice(1)} medal.`
  return tier === 3 ? label : `${label} ${tier === 1 ? 'Silver' : 'Gold'} under ${next} ms.`
}

/** The trick shot's stamp on the win card (hat first: it's the better story). */
export function trickStamp(d: NativeDirector): string | null {
  if (d.hatShot) {
    return 'HAT SHOT'
  }
  return d.handShot ? 'SHOT THE GUN OUT OF HIS HAND' : null
}

/** The lose card's receipt: both times, or why there's only one. */
export function loseTimes(d: NativeDirector): void {
  const you = d.reactionMs ?? d.lateMs
  const him = d.m.hisMs
  if (him === null) {
    d.c.hud.cardTimes(null)
    return
  }
  let note = 'You never drew.'
  if (you !== null) {
    note = you > him ? `${Math.round(you - him)} ms too slow` : 'He got his shot off first.'
  }
  d.c.hud.cardTimes({ you, him, note })
}

/** A press just after he got you, for the lose card's receipt. */
export function lateDraw(d: NativeDirector, t: number): void {
  const m = d.m
  if (d.reactionMs !== null || d.lateMs !== null || m.hisMs === null || d.callTime <= 0) {
    return
  }
  const ms = t - d.callTime
  if (ms > 0 && ms < m.hisMs + 1500) {
    d.lateMs = ms
    if (m.cardShown) {
      loseTimes(d)
    }
  }
}

/** You were shot: the eye-line sinks and rolls into the dirt, the bell tolls low, the card. */
export function beginLose(d: NativeDirector, card: PendingCard): void {
  const m = d.m
  m.card = card
  m.cardShown = false
  m.timeScale = 1
  m.satTarget = 0.2
  const a = d.c.audio
  haptic('hit')
  a.heartbeat(0)
  d.c.hud.clearCall()
  d.c.hud.clearCaptions()
  d.c.hud.letterbox(false)
  d.rig.addTrauma(FEEL.shake.hit)
  a.play('bodyfall', { gain: 0.8, when: a.now + 0.5 })
  a.effort('death', 0.05)
  a.play('bell', { gain: 0.7, rate: 0.6, lowpass: 900, when: a.now + 0.3, reverb: 0.8 })
  if (d.player && d.enemy) {
    // the camera is at his eyes: dust out of his back, nothing in its face
    const P = pos(d.player)
    const away = P.clone().sub(pos(d.enemy))
    away.y = 0
    away.normalize()
    hitFx(d, P.add(V(0, 1.25, 0)).add(away.clone().mulScalar(0.18)), away, false)
  }
  deathShot(d)
  if (d.player) {
    // the camera is his eyes now
    d.player.root.enabled = false
  }
}

export function tickLose(d: NativeDirector): void {
  const m = d.m
  if (!m.cardShown && d.phaseT >= LOSE_CARD_S) {
    m.cardShown = true
    d.c.audio.playSting('defeat')
    m.card?.show()
    loseTimes(d)
  }
}

/** The stall back-shot, still in the walk: he turns, fires, and you fall. */
export function tickBackShot(d: NativeDirector, dt: number): void {
  const m = d.m
  m.backShotT += dt
  if (m.backShotT >= BACKSHOT_TURN_S && m.backShotAt === 1) {
    m.backShotAt = 2
    d.enemy?.shoot()
    const muzzle = d.enemy?.muzzle()
    if (muzzle) {
      shotVisuals(d.game, true).muzzle(muzzle.position, 0.11, muzzle.direction)
    }
    d.c.audio.play('fireBig', { gain: 1.1, pos: pos(d.enemy), reverb: 0.7 })
  }
  if (m.backShotT >= BACKSHOT_HIT_S && m.backShotAt === 2) {
    m.backShotAt = 3
    m.loseReason = 'SHOT IN THE BACK. HE DIDN’T WAIT EITHER.'
    d.resolve('loss', null)
  }
}

/** Stalled too long: he turns and shoots you in the back. */
export function backShotByEnemy(d: NativeDirector): void {
  d.m.backShotAt = 1
  d.m.backShotT = 0
  d.speed = 0
  d.player?.play('Idle', 0.1)
  d.enemy?.play('Draw', 0.05)
  turnTo(d, d.enemy, 180, BACKSHOT_TURN_S)
}

/** You drew early: you spin and fire into his back at 0.4x, then silence, the gasp, the stamp. */
export function beginCoward(d: NativeDirector, card: PendingCard): void {
  const m = d.m
  const early = m.cowardEarlyMs
  m.card = card
  m.cardShown = false
  m.cowardBeat = false
  m.cowardEarlyMs = early
  d.c.audio.heartbeat(0)
  d.c.hud.letterbox(false)
  d.c.hud.clearCall()
  d.c.hud.clearCaptions()
  d.speed = 0
  d.enemy?.play('Idle', 0.08)
  turnTo(d, d.player, 0, COWARD_DRAW_S)
  d.player?.play('Draw', 0.05)
  playerFireFx(d)
  if (d.player && d.enemy) {
    const muzzle = d.player.muzzle()
    if (muzzle) {
      shotVisuals(d.game, true).muzzle(muzzle.position, 0.11, muzzle.direction)
    }
  }
  killEnemyAnim(d, d.enemy)
  m.timeScale = reduced(d) ? 1 : FEEL.cowardScale
  d.arenas.stampPoster(d.level, 'coward')
  cowardShot(d)
}

export function tickCoward(d: NativeDirector): void {
  const m = d.m
  const t = d.phaseT
  m.timeScale = reduced(d) ? 1 : slowMo(t, 0, FEEL.cowardSlow, FEEL.cowardScale)
  if (!m.cowardBeat && t >= FEEL.cowardSlow) {
    m.cowardBeat = true
    d.c.audio.musicLevel(Number.NEGATIVE_INFINITY, 0.06)
    ambience(d, AMB.hush, 0.05)
    d.c.audio.play('gasp', { gain: 1, when: d.c.audio.now + 0.05, reverb: 0.4 })
    d.c.audio.playSting('defeat')
  }
  if (!m.cardShown && t >= FEEL.cowardCardAt) {
    m.cardShown = true
    m.card?.show()
  }
}

/** Boss phase one: a scratch. He staggers, drops his off-hand gun and squares up again. */
export function beginBossWound(d: NativeDirector): void {
  d.m.timeScale = 0
  d.m.turns = []
  d.c.audio.heartbeat(0)
  d.c.hud.letterbox(false)
}

export function tickBossWound(d: NativeDirector): void {
  const t = d.phaseT
  const m = d.m
  if (t < FEEL.hitstopMs / 1000) {
    m.timeScale = 0
    return
  }
  if (!m.swelled) {
    m.swelled = true
    m.timeScale = 0.3
    d.enemy?.play('HitRecieve', 0.05)
    say(d, d.outlaw.name, 'That… that’s just a scratch.', { ms: 2200, force: true })
    d.c.audio.play('shout', { gain: 0.7, rate: 0.6, pos: pos(d.enemy) })
  }
  if (t > 1.1) {
    m.timeScale = 1
  }
  if (t > 2.4) {
    m.swelled = false
    d.enemy?.play('Idle', 0.3)
    d.player?.play('Idle', 0.3)
    d.wait()
  }
}
