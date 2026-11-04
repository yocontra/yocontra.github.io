import { money } from '../data/economy.ts'
import { FEEL } from '../data/feel.ts'
import { haptic } from '../platform/haptics.ts'
import type { Director } from './director.ts'
import { drawAt, fireGun, nearMiss } from './draws.ts'
import { cowardShot, deathShot } from './framing.ts'
import type { EnemyShot } from './judge.ts'
import { killEnemyAnim, playerFireFx, slowMo } from './outcome.ts'
import { AMB, ambience } from './present.ts'
import { book, type Paid, showPurse } from './purse.ts'
import { report } from './report.ts'
import { between, rng, V } from './state.ts'

const CARD_DELAY_MS = 450
const BACKSHOT_TURN_MS = 320
const BACKSHOT_HIT_MS = 340
/** The coward's spin and draw (it plays out in the slow-mo). */
const COWARD_DRAW_S = 0.26

/** An outlaw (0 = him, 1 = the rifleman) fires: flash, smoke, report. */
function shooterFx(d: Director, who: number): void {
  const c = d.c
  const shooter = who === 1 ? d.rifleman : d.enemy
  if (!shooter) {
    return
  }
  let off = false
  if (who === 0) {
    shooter.play('Gun_Shoot', 0.05, true, 1.6)
    // out and on you this frame, wherever his draw had got to; two guns take turns
    off = fireGun(shooter)
  } else {
    // the rooftop rifle kicks
    shooter.kickLong()
  }
  const m = shooter.muzzle(V(), off)
  c.flash.fire(m, 0.8)
  c.world.flashLight.position.copy(m)
  c.world.flashLight.intensity = 30
  c.puffs.emit(m, 10, {
    speed: 0.8,
    size: 0.12,
    grow: 0.8,
    life: 1.6,
    color: 0xb8_b0_a8,
    alpha: 0.35,
    up: 0.2,
  })
  c.audio.play('fireBig', { gain: 1.1, pos: shooter.root.position.clone(), reverb: 0.7 })
  if (!d.reduced) {
    d.ca = 0.012
  }
}

/** A miss: whizz, ricochet, dust kick by your boots. You can still win. */
function missFx(d: Director): void {
  const c = d.c
  c.audio.whizz(rng() < 0.5 ? -0.7 : 0.7)
  c.audio.effort('flinch', 0.12)
  c.audio.play('ricochet', {
    offset: Math.floor(rng() * 4),
    duration: 0.8,
    gain: 0.8,
    when: c.audio.now + 0.08,
    pos: d.player.root.position.clone().add(V(between(-2, 2), 0, between(-3, -1))),
  })
  const hitP = d.player.root.position.clone().add(V(between(-1.2, 1.2), 0.05, between(-2.5, -0.8)))
  c.puffs.emit(hitP, 30, { speed: 1.6, size: 0.1, life: 1.2, alpha: 0.5, up: 1.4 })
  c.sparks.emit(hitP.setY(0.1), 12, {
    speed: 3,
    size: 0.03,
    life: 0.25,
    color: 0xff_d0_80,
    alpha: 1,
    up: 2,
    drag: 1,
  })
  c.rig.addTrauma(FEEL.shake.whizz)
}

/** Practice: a planned enemy shot goes off. */
export function enemyFires(d: Director, s: EnemyShot): void {
  s.done = true
  shooterFx(d, s.who)
  if (s.hit) {
    d.hisMs = s.t - d.callT
    playerHit(d, s.who === 1 ? 'The rifleman got you.' : '', null)
  } else {
    missFx(d)
    nearMiss(d.player)
    d.secondChance = true
  }
}

/**
 * Ranked: the server says he got you. Show his shot, then your fall. `times` are the server's:
 * your shot (if any) and his, ms after the call.
 */
export function shotDown(
  d: Director,
  who: number,
  paid: Paid,
  times: { you: number | null; him: number | null },
): void {
  d.hisMs = times.him
  d.lateMs = times.you
  shooterFx(d, who)
  playerHit(d, who === 1 ? 'The rifleman got you.' : '', paid)
}

/** The lose card's receipt: both times, or why there's only one. */
function loseTimes(d: Director): void {
  const you = d.lastReaction ?? d.lateMs
  const him = d.hisMs
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

/** Practice: your press just after he got you (before the card), for the lose card's receipt. */
export function lateDraw(d: Director, p: { t: number }): void {
  if (d.lastReaction !== null || d.lateMs !== null || d.hisMs === null || d.callT <= 0) {
    return
  }
  const ms = p.t - d.callT
  // a press long after the shot is a tap on the card, not a draw
  if (ms > 0 && ms < d.hisMs + 1500) {
    d.lateMs = ms
    if (d.resultShown) {
      loseTimes(d)
    }
  }
}

export function playerHit(d: Director, reason: string, paid: Paid | null): void {
  const c = d.c
  d.enter('lose')
  d.loseReason = reason
  d.resultShown = false
  if (paid || !d.ranked) {
    book(d, { outcome: 'loss', reactionMs: d.lastReaction }, paid)
  }
  report(d, 'loss', d.lastReaction)
  haptic('hit')
  c.audio.heartbeat(0)
  c.hud.clearCall()
  c.hud.clearCaptions()
  c.rig.addTrauma(FEEL.shake.hit)
  c.audio.play('bodyfall', { gain: 0.8, when: c.audio.now + 0.5 })
  c.audio.effort('death', 0.05)
  c.audio.play('bell', {
    gain: 0.7,
    rate: 0.6,
    lowpass: 900,
    pos: c.world.bellPos,
    when: c.audio.now + 0.3,
    reverb: 0.8,
  })
  d.satTarget = 0.2
  d.timeScale = 1
  deathShot(d)
  setTimeout(() => {
    if (d.phase !== 'lose') {
      return
    }
    c.audio.playSting('defeat')
    c.hud.showCard({
      kind: 'lose',
      title: 'YOU LOSE',
      big: '',
      sub: d.loseReason || `${d.outlaw.name} was quicker.`,
      hint: 'press to try again',
    })
    d.resultShown = true
    loseTimes(d)
  }, CARD_DELAY_MS)
  d.player.root.visible = false
}

/** Stalled too long: he turns and shoots you in the back. */
export function backShotByEnemy(d: Director): void {
  const c = d.c
  const e = d.enemy
  d.player.stopWalk(0.1)
  // ranked: the server still needs a standoff; it times out as a loss on its own
  d.ensureStandoff()
  if (e) {
    e.stopWalk(0.1)
    drawAt(e, d.player, Math.PI, BACKSHOT_TURN_MS / 1000)
    setTimeout(() => {
      e.play('Gun_Shoot', 0.05, true, 1.6)
      fireGun(e)
      c.flash.fire(e.muzzle(V()))
      c.audio.play('fireBig', { gain: 1.1, pos: e.root.position.clone(), reverb: 0.7 })
    }, BACKSHOT_TURN_MS)
  }
  d.enter('lose')
  d.hisMs = null
  setTimeout(() => {
    playerHit(d, 'SHOT IN THE BACK. HE DIDN’T WAIT EITHER.', null)
  }, BACKSHOT_HIT_MS)
}

/**
 * You drew early and shot him in the back: the kill-cam two-shot at 0.4x,
 * then silence, the town's gasp, and the stamped poster.
 */
export function coward(d: Director, note: string): void {
  const c = d.c
  // how early: negative ms before the call (or -1 when no call was set yet)
  const callAt = d.tCall > 0 ? d.tCall : d.clock.callAt()
  const early =
    (d.phase === 'wait' || d.phase === 'bossClock') && callAt !== null
      ? Math.min(-1, performance.now() - callAt)
      : -1
  d.cowardEarlyMs = early < -1 ? -early : null
  d.enter('coward')
  d.cowardNote = note
  c.save.cowardice++
  d.cowardDelta = d.ranked ? 0 : book(d, { outcome: 'coward', reactionMs: early }, null)
  report(d, 'coward', null)
  haptic('shot')
  d.bellVoice?.stop()
  d.bellVoice = null
  c.audio.heartbeat(0)
  c.hud.letterbox(false)
  c.hud.clearCall()
  c.hud.clearCaptions()
  d.player.stopWalk(0.08)
  d.enemy?.stopWalk(0.08)
  // he spins and fires from the hip into a turned back
  if (d.enemy) {
    drawAt(d.player, d.enemy, 0, COWARD_DRAW_S)
  } else {
    d.player.root.rotation.y = 0
  }
  playerFireFx(d)
  d.enemyAlive = false
  killEnemyAnim(d)
  d.timeScale = d.reduced ? 1 : FEEL.cowardScale
  d.cowardBeat = false
  d.cowardCard = false
  d.drawPosterTex('coward')
  cowardShot(d)
}

/** Ranked: the server's fine for a back-shot (or a too-quick guess). */
export function cowardFined(d: Director, paid: Paid): void {
  d.cowardDelta = book(d, { outcome: 'coward', reactionMs: -1 }, paid)
  if (d.cowardCard) {
    showFine(d)
  }
}

function showFine(d: Director): void {
  if (d.cowardDelta < 0) {
    d.c.hud.cardPayout(`Fined ${money(-d.cowardDelta)}`)
  }
  showPurse(d, d.cowardDelta)
}

export function tickCoward(d: Director): void {
  const c = d.c
  const t = d.phaseT
  d.timeScale = d.reduced ? 1 : slowMo(t, 0, FEEL.cowardSlow, FEEL.cowardScale)
  if (!d.cowardBeat && t >= FEEL.cowardSlow) {
    d.cowardBeat = true
    c.audio.musicLevel(Number.NEGATIVE_INFINITY, 0.06)
    ambience(d, AMB.hush, 0.05)
    c.audio.play('gasp', { gain: 1, when: c.audio.now + 0.05, reverb: 0.4 })
    // the score is cut; the sting plays past the cut
    c.audio.playSting('defeat')
  }
  if (!d.cowardCard && t >= FEEL.cowardCardAt) {
    d.cowardCard = true
    const n = c.save.cowardice
    c.hud.showCard({
      kind: 'coward',
      title: 'COWARD.',
      big: '',
      sub: d.cowardNote || `You drew before the bell. No bounty. (Early draws: ${n})`,
      hint: 'press to try again',
    })
    c.hud.cardPoster(d.posterCanvas.toDataURL('image/jpeg', 0.8))
    if (!d.cowardNote) {
      const ms = d.cowardEarlyMs
      c.hud.cardTimes({
        you: null,
        him: null,
        note:
          ms === null
            ? 'You drew before the bell.'
            : `You drew ${Math.round(ms)} ms before the bell.`,
      })
    }
    showFine(d)
  }
  if (t > FEEL.cowardAutoRetry) {
    d.retry()
  }
}
