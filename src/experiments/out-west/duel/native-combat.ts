import { Vec3 } from 'playcanvas'
import type { SfxName } from '../audio/audio.ts'
import { type DuelOutcome, money } from '../data/economy.ts'
import { FEEL } from '../data/feel.ts'
import {
  ASSIST_MS,
  BOSS_PHASE2,
  BOSS_STRIKE_INTERVAL,
  gradeFor,
  legendDraw,
  RIFLEMAN,
  TOUCH_ALLOWANCE_MS,
} from '../data/outlaws.ts'
import type { Press } from '../engine/input.ts'
import { reportDuel } from '../meta/events.ts'
import { save } from '../save.ts'
import type { Verdict } from './clock.ts'
import { type EnemyShot, planShots, shotsBefore } from './judge.ts'
import type { NativeDirector } from './native-director.ts'
import { dropEnemyProps, duelShot, plannedShot } from './native-shot.ts'
import { practicePurse } from './purse.ts'

/** As the wait opens (and after a retry), presses are held this long ("steady…"), never fined. */
export const STEADY_MS = 800

/** Clear what one attempt at this outlaw earns: a fresh walk, the boss's next phase or its retry. */
export function resetAttempt(d: NativeDirector): void {
  d.stalled = 0
  d.stallHeckled = false
  d.speed = 0
  d.hatShot = false
  d.handShot = false
  d.secondChance = false
}

export function wait(d: NativeDirector): void {
  const outlaw = d.outlaw
  if (!outlaw) {
    return
  }
  d.enter('wait')
  d.c.hud.hideCard()
  d.shots = 0
  d.fakes = 0
  d.reactionMs = null
  d.lateMs = null
  d.callTime = 0
  d.plan = null
  d.bellScheduled = false
  d.bellAt = 0
  d.steadyUntil = Math.max(d.steadyUntil, performance.now() + STEADY_MS)
  const boss = outlaw.gimmick === 'boss'
  const bossClock = boss && d.bossPhase === 1
  const waitRange = boss && d.bossPhase === 2 ? [1.5, 4] : outlaw.wait
  const forced = outlaw.gimmick === 'piano' ? ['piano-stop'] : []
  if (outlaw.gimmick === 'coin' && Math.random() < 0.7) {
    forced.push('coin')
  }
  d.duel = d.clock.standoff({
    level: d.level,
    waitMs: [(waitRange[0] ?? 1.5) * 1000, (waitRange[1] ?? 4) * 1000],
    fakeChance: outlaw.fakeChance,
    maxFakes: boss || d.riflemanAlive ? FEEL.maxFakesBoss : FEEL.maxFakes,
    cues: bossClock ? ['miscount'] : outlaw.fakes,
    forced,
    sequence: bossClock
      ? {
          cues: ['strike:6', 'strike:7', 'strike:8', 'strike:9', 'strike:10', 'strike:11'],
          intervalMs: [BOSS_STRIKE_INTERVAL[0] * 1000, BOSS_STRIKE_INTERVAL[1] * 1000],
        }
      : null,
    touch: d.c.input.touch,
  })
  const identity = new Map([
    ['drunk', 'Idle_Drunk'],
    ['shaky', 'Idle_Shaky'],
  ])
  d.enemy?.idle(identity.get(outlaw.gimmick) ?? 'Idle_Character')
  d.player?.play('Idle_Gun')
  d.enemy?.play('Idle_Gun')
  if (outlaw.gimmick === 'cards') {
    d.atmosphere.cue('cards', d.enemy)
  }
  if (outlaw.gimmick === 'windy') {
    d.atmosphere.cue('gust', d.enemy)
  }
  d.c.audio.musicLevel(FEEL.waitDuckDb, 0.5)
  d.c.audio.musicLowpass(FEEL.waitLowpass, 0.5)
}

export function call(d: NativeDirector): void {
  if (d.phase !== 'wait' && !d.remote) {
    return
  }
  // his draw starts as the call frame begins, before the engine's own systems spend any of it
  const now = d.frameStart ?? performance.now()
  // reactions count from the instant the bell is heard
  d.callTime = d.bellScheduled ? d.bellAt : now
  d.enter('call')
  d.player?.face(0)
  d.enemy?.face(180)
  d.player?.play('Draw', 0.03)
  d.enemy?.play('Draw', 0.03)
  if (!d.dailyModifiers.includes('no-bell')) {
    d.arenas.toll()
    if (!d.bellScheduled) {
      d.c.audio.call()
    }
    d.c.hud.call('DRAW!', FEEL.callHoldMs)
  }
  d.c.audio.heartbeat(0)
  if (d.ranked || d.remote) {
    return
  }
  const outlaw = d.outlaw
  if (!outlaw) {
    return
  }
  const baseDraw = d.bossPhase === 2 ? BOSS_PHASE2.draw : outlaw.draw
  const draw = d.c.save.legend ? legendDraw(d.level) : baseDraw
  const baseJitter = d.bossPhase === 2 ? BOSS_PHASE2.jitter : outlaw.jitter
  if (d.c.save.settings.assist) {
    d.c.save.assistUsed = true
  }
  d.plan = planShots(
    now,
    {
      draw,
      jitter: d.c.save.legend ? 0 : baseJitter,
      accuracy: outlaw.accuracy,
      assist:
        (d.c.save.settings.assist ? ASSIST_MS : 0) + (d.c.input.touch ? TOUCH_ALLOWANCE_MS : 0),
      twoGuns: outlaw.gimmick === 'two-guns',
      rifleman: d.riflemanAlive ? RIFLEMAN : null,
      secondShotMs: FEEL.secondShotMs,
      delmerGapMs: FEEL.delmerGapMs,
    },
    Math.random,
  )
}

export function playCue(d: NativeDirector, cue: string): void {
  if (d.phase !== 'wait' && !d.remote) {
    return
  }
  if (!cue.startsWith('strike:')) {
    d.fakes++
  }
  d.atmosphere.cue(cue, d.enemy)
  d.c.hud.fake(`[${cue.replaceAll('-', ' ')}]`, 1500)
  const sounds: Readonly<Record<string, SfxName>> = {
    crow: 'crow',
    dog: 'dog',
    horse: 'horse',
    door: 'door',
    creak: 'door',
    coin: 'coin',
    bottle: 'bottle',
    gunshot: 'fireBig',
    heckle: 'shout',
    hiccup: 'shout',
    whistle: 'hawk',
    piano: 'piano',
    'piano-stop': 'piano',
    twitch: 'holster',
    miscount: 'bell',
  }
  const sound = cue.startsWith('strike:') ? 'bell' : sounds[cue]
  if (sound) {
    d.c.audio.play(sound, { gain: 0.5 })
  }
  if (cue === 'twitch' || cue === 'hiccup') {
    d.enemy?.play(cue === 'hiccup' ? 'Idle_Drunk' : 'Flinch', 0.04)
  }
}

function earlyShot(d: NativeDirector, input: Press): void {
  if (input.t < d.steadyUntil) {
    d.c.hud.fake('steady…')
    return
  }
  // how early, as negative ms before the call (-1 when no call was set yet)
  const bell = d.bellScheduled ? d.bellAt : d.clock.callAt()
  const callAt = d.phase === 'wait' ? bell : null
  const early = callAt === null ? -1 : Math.min(-1, performance.now() - callAt)
  if (d.duel < 0) {
    d.wait()
  }
  d.clock.shot(0, null)
  if (!d.ranked) {
    d.resolve('coward', early)
  }
}
export function handlePress(d: NativeDirector, input: Press): void {
  if (input.action === 'pause') {
    d.togglePause()
    return
  }
  if (d.paused || d.interluding || d.board.isOpen || d.c.hud.menuOpen) {
    return
  }
  if (d.remote) {
    d.remote.press(input)
    return
  }
  switch (d.phase) {
    case 'intro':
      void d.startLevel(d.level)
      return
    case 'poster':
      if (d.phaseT > 0.25 && (input.action === 'skip' || input.action === 'fire')) {
        d.phaseT = FEEL.posterDuration
      }
      return
    case 'win':
      if (d.phaseT > 0.9) {
        d.advance()
      }
      return
    case 'lose':
    case 'coward':
      if (d.phaseT > FEEL.loseRetryPress) {
        d.retry()
      }
      return
    case 'wait':
      if (input.action === 'fire') {
        earlyShot(d, input)
      }
      return
    case 'walk':
      // pointer presses during the walk are walking; a fire key is a back-shot
      if (input.action === 'fire' && input.source === 'key') {
        earlyShot(d, input)
      }
      return
    case 'turn':
      if (input.action === 'fire') {
        earlyShot(d, input)
      }
      return
    case 'call':
      if (input.action === 'fire') {
        d.shoot(input)
      }
      return
    default:
      return
  }
}

function screen(d: NativeDirector, point: Vec3): Vec3 | null {
  const projected = d.game.camera.camera?.worldToScreen(point)
  if (!projected) {
    return null
  }
  const canvas = d.game.app.graphicsDevice.canvas
  const rect = canvas.getBoundingClientRect()
  projected.x = rect.left + (projected.x * rect.width) / canvas.width
  projected.y = rect.top + (projected.y * rect.height) / canvas.height
  return projected
}
function shotTarget(d: NativeDirector): number {
  // Wire target 0 is the rifleman, then 1 is Curly, on every input modality.
  return d.outlaw.gimmick === 'underboss' ? Math.min(d.shots, 1) : 0
}
function trickShot(d: NativeDirector, press: Press, target: number): void {
  if (press.source !== 'pointer' || !d.enemy || (d.riflemanAlive && target === 0)) {
    return
  }
  const head = d.enemy.model.findByName('Head')
  const hat = head
    ? screen(
        d,
        head
          .getPosition()
          .clone()
          .add(new Vec3(0, 0.12, 0)),
      )
    : null
  if (hat && Math.hypot(hat.x - press.x, hat.y - press.y) < Math.max(40, innerHeight * 0.06)) {
    d.hatShot = true
    return
  }
  const wrist = d.enemy.model.findByName('WristR')
  const hand = wrist ? screen(d, wrist.getPosition()) : null
  d.handShot ||= Boolean(
    hand && Math.hypot(hand.x - press.x, hand.y - press.y) < Math.max(28, innerHeight * 0.04),
  )
}

function acceptLocalShot(d: NativeDirector, press: Press): boolean {
  if (!d.plan) {
    return false
  }
  for (const shot of shotsBefore(d.plan, press.t, FEEL.tieMs, (who) =>
    who === 0 ? d.enemyAlive : d.riflemanAlive,
  )) {
    enemyFires(d, shot)
    if (shot.hit) {
      // he got there first in this same frame: the press only goes on the lose card
      d.lateMs ??= press.t - d.callTime
      return false
    }
  }
  return !(
    d.outlaw.gimmick === 'underboss' &&
    d.shots > 0 &&
    press.t - d.callTime - (d.reactionMs ?? 0) < FEEL.twoTargetGapMs
  )
}

export function shoot(d: NativeDirector, press: Press): void {
  const ms = press.t - d.callTime
  const underboss = d.outlaw.gimmick === 'underboss'
  if (d.ranked && d.shots >= (underboss ? 2 : 1)) {
    return
  }
  if (!(d.ranked || d.remote || acceptLocalShot(d, press))) {
    return
  }
  const target = shotTarget(d)
  d.shots++
  d.reactionMs ??= ms
  d.c.audio.play('fire', { gain: 0.8 })
  const victim = d.riflemanAlive && (target === 0 || !d.enemyAlive) ? d.rifleman : d.enemy
  duelShot(d, d.player, victim)
  trickShot(d, press, target)
  d.clock.shot(target, ms)
  if (d.ranked || d.remote) {
    return
  }
  if (d.riflemanAlive && (target === 0 || !d.enemyAlive)) {
    d.riflemanAlive = false
    dropEnemyProps(d, d.rifleman)
    d.rifleman?.play('Death', 0)
  } else {
    d.enemyAlive = false
    if (d.outlaw.gimmick !== 'boss' || d.bossPhase !== 1) {
      dropEnemyProps(d, d.enemy)
    }
    d.enemy?.play('Death', 0)
  }
  if (!(d.enemyAlive || d.riflemanAlive)) {
    // the ledger's number is the first press, also when two targets fall
    d.resolve('win', d.reactionMs)
  }
}

/** Practice: a planned enemy shot goes off; a miss leaves you a second chance. */
export function enemyFires(d: NativeDirector, shot: EnemyShot): void {
  shot.done = true
  plannedShot(d, shot)
  if (shot.hit) {
    d.resolve('loss', d.reactionMs)
  } else {
    d.secondChance = true
  }
}

export function applyVerdict(d: NativeDirector, verdict: Verdict): void {
  if (verdict.duel !== d.duel) {
    return
  }
  if (verdict.outcome === 'loss' && verdict.enemyMs !== null && d.phase !== 'lose') {
    duelShot(d, d.enemy, d.player)
    d.c.audio.play('fireBig', {
      gain: 1.1,
      ...(d.enemy ? { pos: d.enemy.root.getPosition() } : {}),
    })
  }
  d.dailyVerdict = verdict
  d.resolve(verdict.outcome, verdict.reactionMs, verdict)
}

export function resolve(
  d: NativeDirector,
  outcome: DuelOutcome,
  ms: number | null,
  verdict?: Verdict,
): void {
  if (d.phase === 'win' || d.phase === 'lose' || d.phase === 'coward') {
    return
  }
  d.clock.cancel()
  d.c.audio.heartbeat(0)
  if (outcome === 'win' && d.outlaw?.gimmick === 'boss' && d.bossPhase === 1) {
    if (ms !== null && !(d.daily || d.remote)) {
      recordBest(d, ms)
      save(d.c.save)
    }
    d.bossPhase = 2
    d.enemyAlive = true
    d.secondChance = false
    d.enemy?.play('HitRecieve', 0)
    d.enter('bossWound')
    return
  }
  d.enter(outcome === 'loss' ? 'lose' : outcome)
  if (outcome === 'win') {
    dropEnemyProps(d, d.enemy)
    d.enemy?.play('Death', 0)
    dropEnemyProps(d, d.rifleman)
    d.rifleman?.play('Death', 0)
  } else {
    d.player?.play('Death', 0)
  }
  const before = bookResult(d, outcome, ms, verdict)
  showResult(d, { outcome, ms, verdict, before })
}

function bookResult(
  d: NativeDirector,
  outcome: DuelOutcome,
  ms: number | null,
  verdict: Verdict | undefined,
): number {
  const data = d.c.save
  const before = data.run.total
  if (!(d.daily || d.remote)) {
    data.run.duels.push({
      level: d.level,
      outcome,
      reactionMs: ms === null ? null : Math.round(ms * 10) / 10,
    })
    data.run.total = verdict ? verdict.purse : practicePurse(data.run.duels)
    if (outcome === 'coward') {
      data.cowardice++
    }
    if (outcome === 'win' && ms !== null) {
      recordBest(d, ms)
    }
    save(data)
  }
  return before
}
function recordBest(d: NativeDirector, ms: number): void {
  const data = d.c.save
  const best = data.best[d.level]
  if (!best || ms < best.ms) {
    data.best[d.level] = {
      ms,
      grade: gradeFor(ms, d.secondChance),
      attempts: data.attempts[d.level] ?? 1,
    }
  } else {
    best.attempts = data.attempts[d.level] ?? best.attempts
  }
}
function showResult(
  d: NativeDirector,
  result: { outcome: DuelOutcome; ms: number | null; verdict: Verdict | undefined; before: number },
): void {
  const { outcome, ms, verdict, before } = result
  const data = d.c.save
  if (!d.remote) {
    reportDuel({
      level: d.level,
      legend: data.legend,
      ranked: d.ranked,
      outcome,
      reactionMs: outcome === 'coward' ? null : ms,
      // ranked medals are the server's, judged without the touch allowance
      touch: d.c.input.touch && !d.ranked,
      secondChance: d.secondChance,
      hatShot: d.hatShot,
      fakesSeen: d.fakes,
      firstTry: (data.attempts[d.level] ?? 1) <= 1,
      daily: d.daily,
    })
  }
  const sub = outcome === 'coward' ? 'Wait for the call.' : `${d.outlaw.name} drew first.`
  const hint = outcome === 'win' ? 'Tap to continue' : 'Tap to retry'
  const titles = { win: 'BOUNTY COLLECTED', loss: 'TOO SLOW', coward: 'BACK-SHOT' }
  d.c.hud.showCard({
    kind: outcome === 'loss' ? 'lose' : outcome,
    title: titles[outcome],
    big: ms === null ? '—' : `${Math.max(0, Math.round(ms))} ms`,
    sub: outcome === 'win' ? gradeFor(ms ?? 0, d.secondChance) : sub,
    hint: d.daily ? 'Tap to return to the saloon' : hint,
  })
  const delta = verdict?.payout ?? data.run.total - before
  d.c.hud.cardPayout(delta ? `${delta > 0 ? '+' : ''}${money(delta)}` : '')
  d.c.hud.setPurse(verdict?.purse ?? data.run.total, true)
}
