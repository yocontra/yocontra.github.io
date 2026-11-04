import { MathUtils, Quaternion } from 'three'
import { FEEL } from '../data/feel.ts'
import { gradeFor } from '../data/outlaws.ts'
import { save as persist } from '../save.ts'
import { clamp01 } from '../scene/camera.ts'
import { say } from './chatter.ts'
import { deathStyle, hitFx } from './cues-life.ts'
import type { Director } from './director.ts'
import { fireGun, spinHolster, victoryTaunt } from './draws.ts'
import { killShot } from './framing.ts'
import { book, type Paid, payLine, showPurse } from './purse.ts'
import { report } from './report.ts'
import { between, type DuelState, V } from './state.ts'

/** Seconds into a win when you twirl the gun back into the holster (the slow-mo is over). */
const SPIN_AT = 1.35
/** After the twirl drops it in the leather: a hat tip to the town. */
const TAUNT_AT = 2.55

/** Your shot: draw, muzzle flash, smoke, report. */
export function playerFireFx(s: DuelState): void {
  const c = s.c
  const p = s.player
  p.play('Gun_Shoot', 0.04, true, 1.8)
  // the gun is out and on him this frame, wherever the draw had got to
  fireGun(p)
  const m = p.muzzle(V())
  c.flash.fire(m, 0.9)
  c.world.flashLight.position.copy(m)
  c.world.flashLight.intensity = 40
  c.puffs.emit(m, 14, {
    speed: 0.9,
    size: 0.14,
    grow: 1,
    life: 2.2,
    color: 0xc8_c0_b8,
    alpha: 0.4,
    up: 0.25,
  })
  c.audio.play('fire', { gain: 1.2, reverb: 0.6 })
  c.audio.effort('draw')
  c.rig.addTrauma(FEEL.shake.own)
  if (!s.reduced) {
    s.ca = 0.012
  }
}

/** He goes down: impact mist at the chest, the hat flies, the fall is timed in his own clock. */
export function killEnemyAnim(s: DuelState): void {
  const c = s.c
  const e = s.enemy
  if (!e) {
    return
  }
  const from = s.player.root.position
  const away = V(e.root.position.x - from.x, 0, e.root.position.z - from.z).normalize()
  const hit = e.root.position
    .clone()
    .add(V(0, e.height * 0.72, 0))
    .addScaledVector(away, -0.12)
  // the death clip varies by hit grade (town-life owns the styles); dust and cloth, never blood
  s.dying = { actor: e, t: 0, contact: 0.66, landed: false }
  s.dying.contact = deathStyle(s, gradeFor(s.lastReaction ?? 999, s.secondChance)).contact
  hitFx(s, e, hit, away, true)
  if (s.handShot) {
    shootGunFromHand(s)
  }
  const hat = e.popHat()
  if (hat) {
    const big = s.hatShot
    c.physics.add(
      hat,
      V(between(-0.4, 0.4), big ? 4.5 : 2.2, 0).addScaledVector(away, big ? 1.6 : 1.0),
      V(between(-6, 6), between(-4, 4), big ? 14 : 6),
      { floor: 0.002 },
    )
  }
}

/** The trick shot: his gun leaves his hand and spins into the dirt (style only, never judged). */
function shootGunFromHand(s: DuelState): void {
  const e = s.enemy
  const g = e?.gun
  if (!(e && g)) {
    return
  }
  g.updateWorldMatrix(true, false)
  const p = V()
  const q = new Quaternion()
  g.matrixWorld.decompose(p, q, V())
  s.c.scene.add(g)
  g.position.copy(p)
  g.quaternion.copy(q)
  g.scale.setScalar(1)
  e.gun = null
  const from = s.player.root.position
  const away = V(p.x - from.x, 0, p.z - from.z).normalize()
  s.c.physics.add(g, V(between(-0.6, 0.6), 2.6, 0).addScaledVector(away, 1.4), V(9, 4, 12), {
    side: true,
    ground: 0.023,
  })
  s.c.audio.play('ricochet', { offset: 0, duration: 0.6, gain: 0.7, pos: p.clone() })
}

/** The trick shot's stamp on the win card, if there was one (hat first: it's the better story). */
function trickStamp(s: DuelState): string | null {
  if (s.hatShot) {
    return 'HAT SHOT'
  }
  return s.handShot ? 'SHOT THE GUN OUT OF HIS HAND' : null
}

/** Advance the dying man's clock; the body fall lands on ground contact. */
export function tickDying(s: DuelState, dt: number): void {
  const d = s.dying
  if (!d || d.landed) {
    return
  }
  d.t += dt
  if (d.t < d.contact) {
    return
  }
  d.landed = true
  const p = d.actor.root.position
  s.c.audio.play('bodyfall', { gain: 0.9, pos: p })
  const away = V(p.x - s.player.root.position.x, 0, p.z - s.player.root.position.z).normalize()
  s.c.puffs.emit(p.clone().addScaledVector(away, 0.7).setY(0.05), 40, {
    speed: 1.2,
    size: 0.16,
    life: 1.5,
    alpha: 0.4,
    up: 0.5,
  })
}

/** The rooftop rifleman tumbles off the saloon. */
export function killRifleman(s: DuelState): void {
  const r = s.rifleman
  if (!(r && s.riflemanAlive)) {
    return
  }
  s.riflemanAlive = false
  r.play('Death', 0.05, true)
  const start = r.root.position.clone()
  s.fallers.push({ obj: r.root, v: V(-2.2, 2.5, 0) })
  s.c.audio.play('bodyfall', { gain: 0.9, pos: start, when: s.c.audio.now + 0.9 })
}

export function tickFallers(s: DuelState, dt: number): void {
  for (const f of s.fallers) {
    f.v.y -= 9.8 * dt
    f.obj.position.addScaledVector(f.v, dt)
    f.obj.rotation.z += dt * 2.5
    if (f.obj.position.y <= 0) {
      f.obj.position.y = 0
      f.v.set(0, 0, 0)
    }
  }
  s.fallers = s.fallers.filter((f) => f.obj.position.y > 0)
}

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

/**
 * You won the draw. `reactionMs` is the first press (the ledger's number);
 * `paid` carries the server's payout and purse in ranked play.
 */
export function win(d: Director, reactionMs: number, paid: Paid | null): void {
  const c = d.c
  const o = d.outlaw
  const r = d.lastReaction ?? reactionMs
  d.lastReaction = r
  d.enter('win')
  d.outcomeT = 0
  d.resultShown = false
  d.killCamStarted = false
  c.audio.heartbeat(0)
  c.hud.clearCall()
  c.hud.clearCaptions()
  const grade = gradeFor(r, d.secondChance)
  const best = c.save.best[d.level]
  if (!best || r < best.ms) {
    c.save.best[d.level] = { ms: r, grade, attempts: c.save.attempts[d.level] ?? 1 }
  } else {
    best.attempts = c.save.attempts[d.level] ?? best.attempts
  }
  persist(c.save)
  // 70 ms hitstop, the red frame, then the kill cam.
  d.timeScale = 0
  d.killDur = d.reduced ? FEEL.killCamSecondsReduced : FEEL.killCamSeconds
  if (d.boss && d.bossPhase === 1) {
    d.enter('bossWound')
    return
  }
  killEnemyAnim(d)
  d.winDelta = book(d, { outcome: 'win', reactionMs: r }, paid)
  report(d, 'win', r)
  d.paidShown = false
  if (d.boss) {
    d.killDur = d.reduced ? 0.8 : FEEL.bossKillSeconds
  }
  // only the boss gets a (very slow) orbit; everyone else a gentle push-in
  d.killOrbit = MathUtils.degToRad(o.gimmick === 'boss' ? 4 : 0)
  if (!c.audio.voice(o.name, 'death', 0.35)) {
    c.audio.play('shout', { gain: 0.9, when: c.audio.now + 0.35 })
  }
  d.drawPosterTex('dead')
}

function startKillCam(d: Director): void {
  const c = d.c
  if (d.outcomeT === 0) {
    d.outcomeT = d.phaseT
    if (d.reduced) {
      c.renderer.grade.u('flash').value = 0.25
    } else {
      d.silhouetteFrames = FEEL.redFrames
    }
  }
  if (!d.killCamStarted) {
    // cut to the two-shot on the red frame, and show the shot from there
    d.killCamStarted = true
    killShot(d)
    const m = d.player.muzzle(V())
    c.flash.fire(m, 0.9)
    c.world.flashLight.position.copy(m)
    c.world.flashLight.intensity = 40
  }
}

function tickBossKill(d: Director, k: number): void {
  if (k > 0.5 && d.midnightBells < 12 && k > 0.5 + d.midnightBells * 0.9) {
    d.toll()
  }
  if (!d.paidShown && k > d.killDur + 0.6) {
    d.paidShown = true
    showPurse(d, d.winDelta)
    say(d, 'Bounty', payLine(d, d.lastReaction ?? 0), { ms: 2600, force: true })
  }
  // let at least six of the twelve tolls ring before the ledger
  if (d.midnightBells >= 6 && k > d.killDur + 1) {
    d.toEnd()
  }
}

export function tickWin(d: Director, realDt: number): void {
  const c = d.c
  const t = d.phaseT
  const hit = FEEL.hitstopMs / 1000
  if (t < hit) {
    d.timeScale = 0
    return
  }
  startKillCam(d)
  const scale = d.reduced ? FEEL.killCamScaleReduced : FEEL.killCamScale
  const k = t - hit
  d.timeScale = slowMo(k, FEEL.killCamLead, d.killDur, scale)
  // music swells back 400 ms after the kill
  if (k > 0.4 && k - realDt <= 0.4) {
    c.audio.musicLowpass(18_000, 0.4)
    c.audio.musicLevel(0, 0.6)
    c.audio.playVictory(gradeFor(d.lastReaction ?? 0, d.secondChance))
  }
  // the kill cam has eased back to 1x: a twirl on the trigger finger, and into the leather
  if (t >= SPIN_AT && t - realDt < SPIN_AT) {
    spinHolster(d.player)
  }
  if (t >= TAUNT_AT && t - realDt < TAUNT_AT) {
    victoryTaunt(d.player)
  }
  if (d.boss) {
    tickBossKill(d, k)
    return
  }
  if (!d.resultShown && t >= FEEL.resultAt) {
    d.resultShown = true
    const r = d.lastReaction ?? 0
    c.hud.showCard({
      kind: 'win',
      title: `${d.outlaw.name.toUpperCase()} IS DEAD`,
      big: `${Math.round(r)} ms`,
      sub: gradeFor(r, d.secondChance),
      hint: 'press to continue',
    })
    c.hud.cardPayout(payLine(d, r))
    c.hud.cardStamp(trickStamp(d))
    showPurse(d, d.winDelta)
  }
  if (t >= FEEL.resultAt + FEEL.resultFor) {
    d.nextLevel()
  }
}

/** Boss phase one: a scratch. He drops his off-hand gun and squares up again. */
export function tickBossWound(d: Director): void {
  const c = d.c
  const t = d.phaseT
  if (t < FEEL.hitstopMs / 1000) {
    d.timeScale = 0
    return
  }
  const e = d.enemy
  if (d.outcomeT === 0) {
    d.outcomeT = t
    d.timeScale = 0.3
    e?.play('HitRecieve', 0.05, true)
    // it leaves his hand where it is
    const g = e?.dropOffGun(c.scene)
    if (g && e) {
      // lies on its side, its half-thickness (2.2 cm) above the dirt
      c.physics.add(g, V(0.6, 1.0, -0.5), V(4, 2, 6), { side: true, ground: 0.023 })
    }
    say(d, d.outlaw.name, 'That… that’s just a scratch.', { ms: 2200, force: true })
    c.audio.play('shout', { gain: 0.7, rate: 0.6, pos: e?.root.position.clone() ?? V() })
  }
  if (t > 1.1) {
    d.timeScale = 1
  }
  if (t > 2.4) {
    d.bossPhase = 2
    d.lastReaction = null
    d.secondChance = false
    d.enemyAlive = true
    e?.play('Idle', 0.3)
    e?.holsterGun()
    d.player.holsterGun()
    d.player.play('Idle', 0.3)
    d.enterWait(false)
  }
}
