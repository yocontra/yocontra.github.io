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
import { planShots, shotsBefore } from './judge.ts'
import type { NativeDirector } from './native-director.ts'
import { practicePurse } from './purse.ts'

export function wait(d: NativeDirector): void {
  const outlaw = d.outlaw
  if (!outlaw) {
    return
  }
  d.enter('wait')
  d.c.hud.hideCard()
  d.shots = 0
  d.hatShot = false
  d.handShot = false
  d.fakes = 0
  d.reactionMs = null
  d.callTime = 0
  d.plan = null
  d.bellScheduled = false
  d.steadyUntil = performance.now() + 800
  const boss = outlaw.gimmick === 'boss'
  const bossClock = boss && d.bossPhase === 1
  const waitRange = boss && d.bossPhase === 2 ? [1.5, 4] : outlaw.wait
  d.duel = d.clock.standoff({
    level: d.level,
    waitMs: [(waitRange[0] ?? 1.5) * 1000, (waitRange[1] ?? 4) * 1000],
    fakeChance: outlaw.fakeChance,
    maxFakes: boss || d.riflemanAlive ? FEEL.maxFakesBoss : FEEL.maxFakes,
    cues: bossClock ? ['miscount'] : outlaw.fakes,
    forced: outlaw.gimmick === 'piano' ? ['piano-stop'] : [],
    sequence: bossClock
      ? {
          cues: ['strike:6', 'strike:7', 'strike:8', 'strike:9', 'strike:10', 'strike:11'],
          intervalMs: [BOSS_STRIKE_INTERVAL[0] * 1000, BOSS_STRIKE_INTERVAL[1] * 1000],
        }
      : null,
    touch: d.c.input.touch,
  })
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
  d.callTime = Math.max(d.clock.callAt() ?? 0, performance.now())
  d.enter('call')
  d.player?.face(0)
  d.enemy?.face(180)
  d.player?.play('Idle_Gun_Pointing', 0.08)
  d.enemy?.play('Idle_Gun_Pointing', 0.08)
  if (!d.dailyModifiers.includes('no-bell')) {
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
  d.plan = planShots(
    d.callTime,
    {
      draw,
      jitter: outlaw.jitter,
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
  d.fakes++
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
    d.enemy?.play('HitRecieve', 0.04)
  }
}

function earlyShot(d: NativeDirector, input: Press): void {
  if (input.t < d.steadyUntil) {
    d.c.hud.fake('steady…')
    return
  }
  if (d.duel < 0) {
    d.wait()
  }
  d.clock.shot(0, null)
  if (!d.ranked) {
    d.resolve('coward', null)
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
    case 'cock':
      if (
        d.phaseT >= FEEL.inputEnableDelay &&
        (input.action === 'walk' || input.action === 'fire')
      ) {
        d.enter('walk')
        d.c.hud.hideCard()
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
    case 'turn':
      if (input.action === 'fire' && input.source === 'key') {
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
function shotTarget(d: NativeDirector, press: Press): number {
  if (!(d.riflemanAlive && d.enemyAlive && press.source === 'pointer' && d.rifleman && d.enemy)) {
    return 0
  }
  const a = screen(
    d,
    d.rifleman.root
      .getPosition()
      .clone()
      .add(new Vec3(0, 1.5, 0)),
  )
  const b = screen(
    d,
    d.enemy.root
      .getPosition()
      .clone()
      .add(new Vec3(0, 1.5, 0)),
  )
  return a &&
    b &&
    Math.hypot(b.x - press.x, b.y - press.y) < Math.hypot(a.x - press.x, a.y - press.y)
    ? 1
    : 0
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

export function shoot(d: NativeDirector, press: Press): void {
  d.shots++
  const ms = press.t - d.callTime
  d.reactionMs ??= ms
  d.player?.play('Gun_Shoot', 0)
  d.c.audio.play('fire', { gain: 0.8 })
  const target = shotTarget(d, press)
  trickShot(d, press, target)
  d.clock.shot(target, ms)
  if (d.ranked || d.remote) {
    return
  }
  if (!d.plan) {
    return
  }
  for (const shot of shotsBefore(d.plan, press.t, FEEL.tieMs, (who) =>
    who === 0 ? d.enemyAlive : d.riflemanAlive,
  )) {
    shot.done = true
    if (shot.hit) {
      d.resolve('loss', ms)
      return
    }
  }
  if (d.riflemanAlive && (target === 0 || !d.enemyAlive)) {
    d.riflemanAlive = false
    d.rifleman?.play('Death', 0)
  } else {
    d.enemyAlive = false
    d.enemy?.play('Death', 0)
  }
  if (!(d.enemyAlive || d.riflemanAlive)) {
    d.resolve('win', ms)
  }
}

export function applyVerdict(d: NativeDirector, verdict: Verdict): void {
  if (verdict.duel !== d.duel) {
    return
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
    d.bossPhase = 2
    d.enemyAlive = true
    d.enemy?.play('HitRecieve', 0)
    d.enter('bossWound')
    return
  }
  d.enter(outcome === 'loss' ? 'lose' : outcome)
  if (outcome === 'win') {
    d.enemy?.play('Death', 0)
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
    data.run.duels.push({ level: d.level, outcome, reactionMs: ms })
    data.run.total = verdict ? verdict.purse : practicePurse(data.run.duels)
    if (outcome === 'coward') {
      data.cowardice++
    }
    if (outcome === 'win' && ms !== null) {
      const best = data.best[d.level]
      if (!best || ms < best.ms) {
        data.best[d.level] = {
          ms,
          grade: gradeFor(ms, false),
          attempts: data.attempts[d.level] ?? 1,
        }
      }
    }
    save(data)
  }
  return before
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
      reactionMs: ms,
      touch: d.c.input.touch,
      secondChance: d.shots > 1,
      hatShot: d.hatShot,
      fakesSeen: d.fakes,
      firstTry: data.attempts[d.level] === 1,
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
    sub: outcome === 'win' ? gradeFor(ms ?? 0, false) : sub,
    hint: d.daily ? 'Tap to return to the saloon' : hint,
  })
  const delta = verdict?.payout ?? data.run.total - before
  d.c.hud.cardPayout(delta ? `${delta > 0 ? '+' : ''}${money(delta)}` : '')
  d.c.hud.setPurse(verdict?.purse ?? data.run.total, true)
}
