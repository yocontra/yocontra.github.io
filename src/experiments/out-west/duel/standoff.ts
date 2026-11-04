import { MathUtils } from 'three'
import { FEEL } from '../data/feel.ts'
import {
  ASSIST_MS,
  BOSS_PHASE2,
  BOSS_STRIKE_INTERVAL,
  legendDraw,
  RIFLEMAN,
} from '../data/outlaws.ts'
import type { Press } from '../engine/input.ts'
import { haptic } from '../platform/haptics.ts'
import { clamp01 } from '../scene/camera.ts'
import type { StandoffSpec } from './clock.ts'
import { playCue } from './cues.ts'
import { enemyFires } from './defeat.ts'
import type { Director } from './director.ts'
import { drawOnCall, drawSecs, REMOTE_DRAW_S } from './draws.ts'
import { callShot, clockInsert, otsShot, standoffShot } from './framing.ts'
import { dueShot, planShots, shotsBefore } from './judge.ts'
import { killEnemyAnim, killRifleman, playerFireFx, win } from './outcome.ts'
import { AMB, ambience, bedLevel, duckForStandoff } from './present.ts'
import { rng, V } from './state.ts'

/** Scheduling margin on top of the output latency, ms (a frame or two of main-thread slack). */
const BELL_MARGIN_MS = 50

/** As the wait opens, presses are held this long ("steady…") so a double tap isn't a back-shot. */
export const STEADY_MS = 800

/** The rifleman's scope-glint marker stays up this long, real seconds. */
const GLINT_MARK_S = 0.3

const NUMBERS = [
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
  'TEN',
  'ELEVEN',
  'TWELVE',
]

/** The boss counts from six: enough to build, short enough not to drag. */
const BOSS_STRIKES = ['strike:6', 'strike:7', 'strike:8', 'strike:9', 'strike:10', 'strike:11']

/** What this standoff looks like, for whichever clock runs it. */
export function standoffSpec(d: Director): StandoffSpec {
  const o = d.outlaw
  const boss2 = d.boss && d.bossPhase === 2
  const bossClock = d.boss && d.bossPhase === 1
  const [lo, hi] = boss2 ? [1.5, 4] : o.wait
  const forced: string[] = []
  if (o.gimmick === 'piano') {
    forced.push('piano-stop')
  }
  if (o.gimmick === 'coin' && rng() < 0.7) {
    forced.push('coin')
  }
  return {
    level: d.level,
    waitMs: [lo * 1000, hi * 1000],
    fakeChance: o.fakeChance,
    maxFakes: d.boss || d.underboss ? FEEL.maxFakesBoss : FEEL.maxFakes,
    cues: bossClock ? ['miscount'] : o.fakes,
    forced,
    sequence: bossClock
      ? {
          cues: BOSS_STRIKES,
          intervalMs: [BOSS_STRIKE_INTERVAL[0] * 1000, BOSS_STRIKE_INTERVAL[1] * 1000],
        }
      : null,
  }
}

function resetWaitState(d: Director): void {
  d.waitStart = performance.now()
  d.tCall = 0
  d.bellScheduled = false
  d.bellVoice = null
  d.ecuDone = false
  d.shotsSent = 0
  d.plan = null
  d.fakesSeen = 0
  d.hisMs = null
  d.lateMs = null
  d.steadyUntil = Math.max(d.steadyUntil, d.waitStart + STEADY_MS)
  d.nextBeat = d.waitStart + 60_000 / FEEL.heartStartBpm
}

/**
 * A faint heartbeat under the thumb through the wait, on the wait's own clock: it never knows when
 * the call is coming, so it can't hint at it, and it stops dead with the phase (platform/haptics.ts:
 * never a buzz on the bell or a fake-out).
 */
function hapticBeat(d: Director, now: number, bpm: number): void {
  if (now >= d.nextBeat) {
    haptic('beat')
    d.nextBeat = now + 60_000 / bpm
  }
}

export function enterWait(d: Director, fromPause: boolean): void {
  const c = d.c
  const o = d.outlaw
  d.enter('wait')
  resetWaitState(d)
  const face = d.backsTurned ? 0 : Math.PI
  d.player.root.rotation.y = d.backsTurned ? Math.PI : 0
  if (d.enemy && d.enemyAlive) {
    d.enemy.root.rotation.y = face
  }
  d.callIsScream = d.boss && d.bossPhase === 2
  d.duelId = d.clock.standoff(standoffSpec(d))
  d.standoffSent = true
  if (o.gimmick === 'piano' && !d.pianoVoice) {
    d.pianoVoice = c.audio.play('piano', { gain: 0.55, pos: V(11.5, 1.6, 2), reverb: 0.3 })
  }
  c.audio.heartbeat(FEEL.heartStartBpm)
  duckForStandoff(d, fromPause ? 0.1 : 0.5)
  ambience(d, AMB.wait, 0.6)
  if (d.enemy) {
    d.enemy.shake = o.gimmick === 'shaky' ? 1 : 0
    if (o.gimmick === 'drunk') {
      d.enemy.shake = 0.3
    }
  }
  if (d.backsTurned) {
    standoffShot(d, true, 0.4)
  } else {
    otsShot(d, true, 0.4)
  }
  c.hud.letterbox(false)
}

/**
 * The bell on the audio clock. Whenever the call's time is known ahead (practice rolls it; ranked
 * and Bounty Hunt servers send it `inMs` ahead), the bell is scheduled so its strike reaches the ear
 * on the call frame: `perfToCtx` maps through the output timestamp, so the device's output latency
 * is paid in advance rather than after DRAW! (client presentation only; the server never sees it).
 * The lookahead covers that latency plus a margin, or the start would land in the past and clamp.
 */
function scheduleBell(d: Director, now: number): void {
  const c = d.c
  const callAt = d.clock.callAt()
  const lookahead = Math.max(FEEL.bellLookaheadMs, c.audio.outputLatencyMs + BELL_MARGIN_MS)
  if (callAt === null || d.bellScheduled || now < callAt - lookahead) {
    return
  }
  d.bellScheduled = true
  // a call that reached us late rings now: reactions count from now, not from a moment already gone
  d.tCall = Math.max(callAt, now)
  if (!d.callPresentation.bell) {
    return
  }
  const when = c.audio.perfToCtx(d.tCall)
  // The call is never distance-attenuated: it rings close and centred and ducks the mix.
  d.bellVoice = c.audio.call(when)
  if (d.callIsScream) {
    c.audio.play('shout', {
      gain: 1.0,
      when,
      rate: 0.7,
      pos: d.enemy?.root.position.clone() ?? V(),
    })
  }
}

export function tickWait(d: Director, now: number): void {
  const c = d.c
  const sec = (now - d.waitStart) / 1000
  const bpm = Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + FEEL.heartBpmPerSecond * sec)
  c.audio.heartbeat(bpm)
  hapticBeat(d, now, bpm)
  d.vignette = MathUtils.lerp(FEEL.vignetteBase, FEEL.vignetteWait, clamp01(sec / 2))
  // tension without cutting: the letterbox closes in at 2 s, the camera keeps its slow push
  const callAt = d.clock.callAt()
  if (!d.ecuDone && sec >= 2 && (callAt === null || callAt - now > 900)) {
    d.ecuDone = true
    if (!d.reduced) {
      c.hud.letterbox(true)
    }
  }
  scheduleBell(d, now)
  d.clock.tick(now)
}

// ---------------------------------------------------------------- the boss's clock

export function enterBossClock(d: Director): void {
  const c = d.c
  d.enter('bossClock')
  resetWaitState(d)
  d.bossPhase = 1
  d.strikes = 5
  d.clockInsertUntil = 0
  c.world.setClock(11, 59)
  duckForStandoff(d, 0.6)
  c.audio.heartbeat(FEEL.heartStartBpm)
  ambience(d, AMB.bossClock, 0.6)
  d.player.root.rotation.y = 0
  d.enemy?.root.rotation.set(0, Math.PI, 0)
  d.duelId = d.clock.standoff(standoffSpec(d))
  d.standoffSent = true
  otsShot(d, true)
}

export function tickBossClock(d: Director, now: number): void {
  const sec = d.phaseT
  const bpm = Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + 4 * sec)
  d.c.audio.heartbeat(bpm)
  hapticBeat(d, now, bpm)
  d.vignette = MathUtils.lerp(FEEL.vignetteBase, FEEL.vignetteWait, clamp01(sec / 6))
  // back from a clock-face insert to the standoff
  if (d.c.rig.name === 'clock' && d.realTime >= d.clockInsertUntil) {
    otsShot(d, true, 0)
  }
  scheduleBell(d, now)
  d.clock.tick(now)
}

/** A clock strike (6..11); the twelfth is the call itself. */
function strike(d: Director, n: number): void {
  const c = d.c
  d.strikes = n
  c.audio.play('bell', { gain: 0.8, pos: c.world.bellPos, reverb: 0.5 })
  c.world.toll()
  c.world.setClock(12, 0)
  // the bell counts, not the man: the wait stays silent but for the strikes (chatter.ts)
  c.hud.fake(`[bell strikes ${NUMBERS[n - 1]?.toLowerCase() ?? n}]`, 900)
  // calm inserts on the clock face: the first strike, and the one before the last
  if (n === 6) {
    clockInsert(d, 1.1)
  } else if (n === 11) {
    clockInsert(d, 0.8)
  }
}

/** A cue from the clock (server or local). Ignored once the standoff is over. */
export function onCue(d: Director, duel: number, cue: string): void {
  if (duel !== d.duelId || (d.phase !== 'wait' && d.phase !== 'bossClock')) {
    return
  }
  if (cue.startsWith('strike:')) {
    strike(d, Number(cue.slice('strike:'.length)) || d.strikes + 1)
    return
  }
  d.fakesSeen++
  playCue(d, cue)
}

// --------------------------------------------------------------------- the call

function planLocal(d: Director, now: number): void {
  const c = d.c
  const o = d.outlaw
  const boss2 = d.boss && d.bossPhase === 2
  const legend = c.save.legend
  let draw = boss2 ? BOSS_PHASE2.draw : o.draw
  let jitter = boss2 ? BOSS_PHASE2.jitter : o.jitter
  if (legend) {
    draw = legendDraw(d.level)
    jitter = 0
  }
  d.plan = planShots(
    now,
    {
      draw,
      jitter,
      accuracy: o.accuracy,
      assist: c.save.settings.assist ? ASSIST_MS : 0,
      twoGuns: o.gimmick === 'two-guns',
      rifleman: d.underboss && d.riflemanAlive ? RIFLEMAN : null,
      secondShotMs: FEEL.secondShotMs,
      delmerGapMs: FEEL.delmerGapMs,
    },
    rng,
  )
  if (c.save.settings.assist) {
    c.save.assistUsed = true
  }
}

/** How long his draw takes: to just before his first planned shot, or his draw stat. */
function enemyDrawSecs(d: Director, now: number): number {
  const first = d.plan?.shots.find((s) => s.who === 0)
  if (first) {
    return drawSecs(first.t - now)
  }
  return d.hooks ? REMOTE_DRAW_S : drawSecs(d.outlaw.draw)
}

/** DRAW! is the bell's caption; a line under it only says what DRAW! can't (a scream). */
function callCaption(d: Director): void {
  const { bell, text } = d.callPresentation
  if (!bell) {
    return
  }
  if (d.callIsScream) {
    d.c.hud.fake(text ? '[he screams]' : '[he screams · the bell tolls]', FEEL.callCaptionMs)
  } else if (!text) {
    d.c.hud.fake('[the bell tolls]', FEEL.callCaptionMs)
  }
}

/** The bell. Both men turn on it, in the same frame; nobody turns early. */
export function onCall(d: Director, duel: number): void {
  if (duel !== d.duelId || (d.phase !== 'wait' && d.phase !== 'bossClock')) {
    return
  }
  const c = d.c
  const now = performance.now()
  if (d.boss && d.bossPhase === 1) {
    c.world.setClock(12, 0)
  }
  // the bed holds where the standoff left it (the call ducks it; it must not swell under the bell)
  ambience(d, bedLevel(d), 0.05)
  d.enter('call')
  // reactions count from the instant the bell is heard (the call frame, within half a frame)
  d.callT = d.bellScheduled ? d.tCall : now
  const { bell, text } = d.callPresentation
  if (!d.bellScheduled && bell) {
    // an old server that sends the call bare: ring it now (late by the output latency)
    d.bellVoice = c.audio.call()
    if (d.callIsScream) {
      c.audio.play('shout', { gain: 1.0, rate: 0.7, pos: d.enemy?.root.position.clone() ?? V() })
    }
  }
  if (bell) {
    c.world.toll()
  }
  if (text) {
    c.hud.call('DRAW!', FEEL.callHoldMs)
  }
  callCaption(d)
  c.hud.letterbox(false)
  c.audio.heartbeat(0)
  if (!d.reduced && text) {
    c.renderer.grade.u('flash').value = 0.5
  }
  if (!d.ranked) {
    planLocal(d, now)
  }
  d.glintFired = false
  // both turn and draw on the bell (presentation: the judge never waits on it)
  drawOnCall(d, enemyDrawSecs(d, now))
  if (d.backsTurned && d.outlaw.gimmick === 'shaky' && d.enemy) {
    const hat = d.enemy.popHat()
    if (hat) {
      // tossed up, off to his side and back away from you, spinning, so it reads as a hat
      // (falling straight past his belt, the edge-on brim read as a ring at the call)
      const p = d.player.root.position
      const e = d.enemy.root.position
      const away = V(e.x - p.x, 0, e.z - p.z).normalize()
      const side = V(-away.z, 0, away.x)
      const vel = V(0, 2.4, 0).addScaledVector(side, 1.3).addScaledVector(away, 1.1)
      c.physics.add(hat, vel, V(7, 2, 9), { floor: 0.002 })
    }
  }
  callShot(d)
  if (d.enemy) {
    d.enemy.shake = 0
    d.enemy.twitch = 0.6
  }
}

const alive = (d: Director, who: number): boolean => (who === 0 ? d.enemyAlive : d.riflemanAlive)

export function tickCall(d: Director, now: number): void {
  const c = d.c
  // the rifleman's scope glint, 150 ms after the call
  if (d.rifleman && d.riflemanAlive && !d.glintFired && now - d.callT >= RIFLEMAN.glintAt) {
    d.glintFired = true
    d.glintMarkUntil = d.realTime + GLINT_MARK_S
    c.glint.fire(glintPos(d))
    c.hud.fake('[a glint on the saloon roof]')
  }
  // a pulsing ring on the glint, so a thumb knows where the second gun is
  if (d.rifleman && d.riflemanAlive && d.realTime < d.glintMarkUntil) {
    const g = d.screenOf(glintPos(d))
    c.hud.marker(g.x, g.y)
  } else {
    c.hud.marker(null, null)
  }
  // ranked: the clock checks the verdict isn't overdue
  d.clock.tick(now)
  const plan = d.plan
  if (!plan) {
    return
  }
  const s = dueShot(plan, now, FEEL.tieMs, (w) => alive(d, w))
  if (s) {
    enemyFires(d, s)
  }
}

/** Where the rifleman's scope catches the light. */
function glintPos(d: Director): ReturnType<typeof V> {
  return (d.rifleman?.headPos(V()) ?? V()).add(V(-0.35, -0.02, 0))
}

/**
 * Which target a press means: 0 = him, 1 = the rifleman (underboss only). The rifleman draws
 * first, so while he lives the first press is always his, on every input (a tap anywhere, a key):
 * aim never decides it, so touch is as fair as a keyboard. Curly takes the next.
 */
function targetOf(d: Director): number {
  return d.underboss && d.riflemanAlive ? 1 : 0
}

/**
 * Pointer aim on him: a tap on his hat takes it (`hatShot`), a tap on his gun hand shoots the gun
 * out of it (`handShot`). Style only: the duel is judged on time, never on aim.
 */
function checkTrickShot(d: Director, p: Press, who: number): void {
  if (p.source !== 'pointer' || p.x < 0 || !d.enemy || who !== 0) {
    return
  }
  const e = d.enemy
  const h = d.screenOf(e.headPos(V()).add(V(0, 0.12, 0)))
  if (Math.hypot(h.x - p.x, h.y - p.y) < Math.max(40, globalThis.innerHeight * 0.06)) {
    d.hatShot = true
    return
  }
  const hand = e.handR?.getWorldPosition(V())
  if (hand) {
    const s = d.screenOf(hand)
    if (Math.hypot(s.x - p.x, s.y - p.y) < Math.max(28, globalThis.innerHeight * 0.04)) {
      d.handShot = true
    }
  }
}

/** Ranked: fire and tell the server; the verdict decides who falls. */
function rankedShot(d: Director, p: Press, who: number): void {
  const targets = d.underboss ? 2 : 1
  if (d.shotsSent >= targets) {
    return
  }
  d.shotsSent++
  d.lastReaction ??= p.t - d.callT
  playerFireFx(d)
  haptic('shot')
  // the server's targets: 0 = the rifleman, 1 = Curly himself; the second shot takes the other
  let target = 0
  if (d.underboss) {
    target = d.shotsSent === 1 ? Number(who !== 1) : 1 - d.firstTarget
    d.firstTarget = target
  }
  d.clock.shot(target, p.t - d.callT)
}

export function playerShoots(d: Director, p: Press): void {
  const who = targetOf(d)
  checkTrickShot(d, p, who)
  if (d.ranked) {
    rankedShot(d, p, who)
    return
  }
  const plan = d.plan
  if (!plan) {
    return
  }
  // Judge on timestamps: any hitting shot that went off before this press wins first.
  for (const s of shotsBefore(plan, p.t, FEEL.tieMs, (w) => alive(d, w))) {
    enemyFires(d, s)
    if (d.phase !== 'call') {
      return
    }
  }
  if (d.underboss && d.targetsDown > 0 && p.t - d.lastPressT < FEEL.twoTargetGapMs) {
    return
  }
  const r = p.t - d.callT
  d.lastPressT = p.t
  d.lastReaction ??= r
  playerFireFx(d)
  haptic('shot')
  d.targetsDown++
  if (who === 1) {
    killRifleman(d)
    if (d.enemyAlive) {
      return
    }
  } else {
    d.enemyAlive = false
    if (d.underboss && d.riflemanAlive) {
      // shot Curly first: the rifleman still gets you
      killEnemyAnim(d)
      return
    }
  }
  win(d, r, null)
}
