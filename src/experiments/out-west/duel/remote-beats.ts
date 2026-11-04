/**
 * The Bounty Hunt beats the gauntlet doesn't have: the lockstep walk (the room counts the paces;
 * we predict the stride while both men hold), the turn on the room's word, the dead heat (both men
 * fall), the sudden-death revival, and the honest man's shot when the other draws early.
 */
import type { Poster, Taunt } from '../contract/duel.ts'
import { FEEL } from '../data/feel.ts'
import type { Outlaw } from '../data/outlaws.ts'
import type { Actor } from '../scene/actor.ts'
import { identityFor } from '../scene/identity.ts'
import { dressedActor } from '../scene/loadout.ts'
import { say } from './chatter.ts'
import type { Director } from './director.ts'
import { drawAt, fireGun, PLAYER_DRAW_S, REMOTE_DRAW_S } from './draws.ts'
import { callShot, standoffShot } from './framing.ts'
import { killEnemyAnim, playerFireFx, win } from './outcome.ts'
import { AMB, ambience, duckForStandoff } from './present.ts'
import { BACK_TO_BACK_Z, rng, V } from './state.ts'

export interface HoldState {
  /** Our walk input as last sent to the room. */
  mine: boolean
  /** The opponent's hold, per the room. */
  theirs: boolean
  /** Sent at least once this walk. */
  sent: boolean
  /** perf time until which an auto-walk pace keeps both men moving. */
  autoUntil: number
}

/**
 * Per frame of the walk: tell the room when you press or release, and stride while you and he
 * both hold (or the room is auto-walking a stall). Never more than one pace ahead of the room.
 */
export function tickRemoteWalk(
  d: Director,
  dt: number,
  h: HoldState,
  send: (down: boolean) => void,
): void {
  const c = d.c
  const want = c.input.walking
  if (want !== h.mine || !h.sent) {
    h.mine = want
    h.sent = true
    send(want)
  }
  const moving = (want && h.theirs) || performance.now() < h.autoUntil
  const rate = dt / FEEL.walkRamp
  d.speed = moving ? Math.min(1, d.speed + rate) : Math.max(0, d.speed - rate)
  const p = d.player
  const cap = (d.paces + 1) * p.paceLength
  p.locomote(d.speed, p.walkDuration / 2 / FEEL.paceSeconds)
  d.pDist = Math.min(cap, d.pDist + (d.speed * p.paceLength * dt) / FEEL.paceSeconds)
  p.root.position.z = -BACK_TO_BACK_Z - d.pDist
  const e = d.enemy
  if (e) {
    e.locomote(d.speed, e.walkDuration / 2 / FEEL.paceSeconds)
    const eCap = (d.paces + 1) * e.paceLength
    d.eDist = Math.min(eCap, d.eDist + (d.speed * e.paceLength * dt) / FEEL.paceSeconds)
    e.root.position.z = BACK_TO_BACK_Z + d.eDist
  }
}

/** The room counted a pace: pips, footfalls, and no lagging behind it. */
export function remotePace(d: Director, n: number, auto: boolean, h: HoldState): void {
  if (d.phase !== 'walk') {
    return
  }
  d.paces = n
  d.c.hud.setPips(n, true)
  if (auto) {
    h.autoUntil = performance.now() + 650
    d.c.hud.fake('[the town walks you on]', 1200)
  }
  d.pDist = Math.max(d.pDist, (n - 0.35) * d.player.paceLength)
  if (d.enemy) {
    d.eDist = Math.max(d.eDist, (n - 0.35) * d.enemy.paceLength)
  }
  const a = d.c.audio
  a.play('spursteps', { offset: Math.floor(rng() * 8), duration: 0.7, gain: 0.55 })
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
    d.c.puffs.emit(V(0, 0.05, e.root.position.z), 6, {
      speed: 0.6,
      size: 0.12,
      life: 1,
      alpha: 0.35,
    })
  }
  d.c.puffs.emit(V(0, 0.05, d.player.root.position.z), 8, {
    speed: 0.7,
    size: 0.12,
    life: 1.1,
    alpha: 0.4,
  })
}

/** The last pace, on the room's word: both men plant their feet, backs still turned. */
export function enterRemoteTurn(d: Director): void {
  const c = d.c
  d.enter('turn')
  d.speed = 0
  c.hud.setPips(d.paces, false)
  d.player.stopWalk(0.2)
  d.enemy?.stopWalk(0.2)
  duckForStandoff(d, 0.9)
  ambience(d, AMB.turn, 0.9)
  standoffShot(d, false, 1.2)
}

/** His draw: flash, smoke and the big report from where he stands. */
function enemyShot(d: Director): void {
  const e = d.enemy
  if (!e) {
    return
  }
  // still facing away (he drew early): he turns as he draws, from the hip
  if (!e.drawing?.active) {
    drawAt(e, d.player, Math.PI, REMOTE_DRAW_S)
  }
  e.play('Gun_Shoot', 0.05, true, 1.6)
  fireGun(e)
  const m = e.muzzle(V())
  d.c.flash.fire(m, 0.8)
  d.c.audio.play('fireBig', { gain: 1.1, pos: e.root.position.clone(), reverb: 0.7 })
}

/** Both shots within 5 ms: both men fall. Sudden death follows. */
export function deadHeatFx(d: Director): void {
  const c = d.c
  if (d.shotsSent === 0) {
    playerFireFx(d)
  }
  enemyShot(d)
  d.enemyAlive = false
  killEnemyAnim(d)
  d.player.play('Death', 0.06, true)
  d.enter('lose')
  c.audio.heartbeat(0)
  c.hud.clearCaptions()
  c.hud.call('DEAD HEAT', 1800)
  c.hud.fake('[both men fall · sudden death]', 2400)
  c.rig.addTrauma(FEEL.shake.hit)
}

/** Sudden death: both back on their feet, backs turned, a fresh wait (no walk). */
export function reviveForSuddenDeath(d: Director, p: Poster | undefined): void {
  const c = d.c
  const old = d.enemy
  const fresh = opponentActor(d, p)
  if (old) {
    fresh.root.position.copy(old.root.position)
    old.dispose()
  }
  c.scene.add(fresh.root)
  d.enemy = fresh
  d.enemyAlive = true
  d.dying = null
  d.timeScale = 1
  d.lastReaction = null
  d.shotsSent = 0
  c.physics.clear()
  d.player.root.visible = true
  d.player.holsterGun()
  d.player.play('Idle', 0.2)
  fresh.holsterGun()
  fresh.play('Idle', 0)
  c.hud.clearCall()
  say(d, 'Sudden death', 'No walk. Wait for the bell.', { ms: 1800, force: true })
  d.enterWait(false)
}

/** He drew early: his shot kicks dust at your boots, you turn and fire. */
export function honestWin(d: Director, line: string): void {
  const c = d.c
  const boots = d.player.root.position.clone().add(V(0.4, 0.05, -0.9))
  c.puffs.emit(boots, 30, { speed: 1.6, size: 0.1, life: 1.2, alpha: 0.5, up: 1.4 })
  c.audio.play('ricochet', { duration: 0.8, gain: 0.8, pos: boots })
  enemyShot(d)
  d.bellVoice?.stop()
  d.bellVoice = null
  if (d.enemy) {
    drawAt(d.player, d.enemy, 0, PLAYER_DRAW_S)
  } else {
    d.player.root.rotation.y = 0
  }
  if (d.phase === 'walk' || d.phase === 'turn') {
    d.player.stopWalk(0.08)
    d.enemy?.stopWalk(0.08)
  }
  d.enter('call')
  d.callT = performance.now()
  callShot(d)
  // the town calls it (not the coward himself)
  say(d, 'The town', line, { ms: 2400, force: true })
  playerFireFx(d)
  d.enemyAlive = false
  win(d, 0, null)
}

export const TAUNT_TEXT: Record<Taunt, string> = {
  draw: 'Draw!',
  'your-move': 'Your move.',
  'nice-hat': 'Nice hat.',
  'say-your-prayers': 'Say your prayers.',
  'tip-hat': '*tips his hat*',
  'good-duel': 'Good duel.',
}

export const HECKLES = ['You plannin’ on walkin’ today?', 'I ain’t got all day, friend.', 'Scared?']

/**
 * The opponent dressed in his own loadout and dyes, with his own face (scene/identity.ts): a Town
 * Outlaw is told apart by his level, since they share a name.
 */
export function opponentActor(d: Director, p: Poster | undefined): Actor {
  const c = d.c
  const key = p?.kind === 'outlaw' ? `${p.name}#${p.level}` : (p?.name ?? 'stranger')
  return dressedActor(c.assets.player, c.gun, p?.loadout ?? {}, {
    dyes: p?.dyes,
    who: identityFor(key, c.assets),
  })
}

/** An outlaw record for the opponent, so the director's captions and framing have a name. */
export function asOutlaw(p: Poster): Outlaw {
  return {
    name: p.kind === 'ghost' ? `Ghost of ${p.name}` : p.name,
    epithet: `Lv ${p.level}`,
    bounty: p.bounty,
    hook: '',
    gimmick: 'cold',
    look: { base: 'casual', tint: {}, scale: 1 },
    hat: 'cowboy',
    hatColor: 0x5a_42_2e,
    paces: [99, 99],
    wait: [2, 5],
    draw: 0,
    jitter: 0,
    fakeChance: 0,
    fakes: [],
    accuracy: 1,
    day: 0.42,
    lines: [],
  }
}
