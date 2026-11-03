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
import { clamp01 } from '../scene/camera.ts'
import type { StandoffSpec } from './clock.ts'
import { playCue } from './cues.ts'
import { enemyFires } from './defeat.ts'
import type { Director } from './director.ts'
import { callShot, clockInsert, otsShot, standoffShot } from './framing.ts'
import { dueShot, planShots, shotsBefore } from './judge.ts'
import { killEnemyAnim, killRifleman, playerFireFx, win } from './outcome.ts'
import { AMB, ambience, bedLevel, duckForStandoff } from './present.ts'
import { rng, V } from './state.ts'

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
  d.turnAnim = []
  d.waitStart = performance.now()
  d.tCall = 0
  d.bellScheduled = false
  d.bellVoice = null
  d.ecuDone = false
  d.shotsSent = 0
  d.plan = null
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

export function tickWait(d: Director, now: number): void {
  const c = d.c
  const sec = (now - d.waitStart) / 1000
  c.audio.heartbeat(Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + FEEL.heartBpmPerSecond * sec))
  d.vignette = MathUtils.lerp(FEEL.vignetteBase, FEEL.vignetteWait, clamp01(sec / 2))
  // tension without cutting: the letterbox closes in at 2 s, the camera keeps its slow push
  const callAt = d.clock.callAt()
  if (!d.ecuDone && sec >= 2 && (callAt === null || callAt - now > 900)) {
    d.ecuDone = true
    if (!d.reduced) {
      c.hud.letterbox(true)
    }
  }
  // practice knows the call ahead: schedule the bell on the audio clock so it lands on the call frame
  if (callAt !== null && !d.bellScheduled && now >= callAt - FEEL.bellLookaheadMs) {
    d.bellScheduled = true
    const when = c.audio.perfToCtx(callAt)
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
  d.c.audio.heartbeat(Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + 4 * sec))
  d.vignette = MathUtils.lerp(FEEL.vignetteBase, FEEL.vignetteWait, clamp01(sec / 6))
  // back from a clock-face insert to the standoff
  if (d.c.rig.name === 'clock' && d.realTime >= d.clockInsertUntil) {
    otsShot(d, true, 0)
  }
  d.clock.tick(now)
}

/** A clock strike (6..11); the twelfth is the call itself. */
function strike(d: Director, n: number): void {
  const c = d.c
  d.strikes = n
  c.audio.play('bell', { gain: 0.8, pos: c.world.bellPos, reverb: 0.5 })
  c.world.setClock(12, 0)
  c.hud.line(d.outlaw.name, `${NUMBERS[n - 1] ?? ''}…`, 900)
  c.hud.fake(`[bell strikes ${n}]`)
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
  d.callT = now
  if (!d.bellScheduled) {
    d.bellVoice = c.audio.call()
    if (d.callIsScream) {
      c.audio.play('shout', { gain: 1.0, rate: 0.7, pos: d.enemy?.root.position.clone() ?? V() })
    }
  }
  c.hud.call('DRAW!', FEEL.callHoldMs)
  c.hud.fake(d.callIsScream ? '[HE SCREAMS] [BELL TOLLS]' : '[BELL TOLLS]', FEEL.callCaptionMs)
  c.hud.letterbox(false)
  c.audio.heartbeat(0)
  if (!d.reduced) {
    c.renderer.grade.u('flash').value = 0.5
  }
  if (!d.ranked) {
    planLocal(d, now)
  }
  d.glintFired = false
  if (d.backsTurned) {
    d.turnActor(d.player, Math.PI, Math.PI * 2)
    if (d.enemy && d.enemyAlive) {
      d.turnActor(d.enemy, 0, Math.PI)
    }
    if (d.outlaw.gimmick === 'shaky' && d.enemy) {
      const hat = d.enemy.popHat()
      if (hat) {
        c.physics.add(hat, V(0.3, 1.4, -0.4), V(2, 1, 3))
      }
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
    c.glint.fire(d.rifleman.headPos(V()).add(V(-0.35, -0.02, 0)))
    c.hud.fake('[a glint on the saloon roof]')
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

/** Which target a press means: 0 = him, 1 = the rifleman (underboss only). */
function targetOf(d: Director, p: Press): number {
  if (!(d.underboss && d.riflemanAlive)) {
    return 0
  }
  if (!d.enemyAlive) {
    return 1
  }
  if (p.source === 'pointer' && p.x >= 0) {
    const e = d.screenOf(d.enemy?.headPos(V()) ?? V())
    const r = d.screenOf(d.rifleman?.headPos(V()) ?? V())
    return Math.hypot(e.x - p.x, e.y - p.y) < Math.hypot(r.x - p.x, r.y - p.y) ? 0 : 1
  }
  return 1
}

function checkHatShot(d: Director, p: Press, who: number): void {
  if (p.source !== 'pointer' || !d.enemy || who !== 0) {
    return
  }
  const h = d.screenOf(d.enemy.headPos(V()).add(V(0, 0.12, 0)))
  if (Math.hypot(h.x - p.x, h.y - p.y) < Math.max(40, globalThis.innerHeight * 0.06)) {
    d.hatShot = true
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
  // the server's targets: 0 = the rifleman, 1 = Curly himself; the second shot takes the other
  let target = 0
  if (d.underboss) {
    target = d.shotsSent === 1 ? Number(who !== 1) : 1 - d.firstTarget
    d.firstTarget = target
  }
  d.clock.shot(target, p.t - d.callT)
}

export function playerShoots(d: Director, p: Press): void {
  const who = targetOf(d, p)
  checkHatShot(d, p, who)
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
