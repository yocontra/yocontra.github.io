/**
 * The duel's side of town life and hit feedback (owned with `cues.ts`):
 *
 * - `hitFx`: a shot lands on a man. A dust-and-cloth puff and a small bright spark at the impact
 *   (no blood), and a short camera impulse, readable but calm.
 * - `deathStyle`: his fall by the grade of your draw. LIGHTNING flips his hat high and lets him
 *   fall slow; the others stagger first (a hit, a second hit) or drop like a stone.
 * - `tickLife`, every frame after the duel: tells the town what's happening (the call, the shot,
 *   a new duel), keeps the muzzle light off your own arm, trails smoke from a fired barrel, and
 *   applies the two hooks above itself whenever the outcome code hasn't.
 */
import { type Object3D, Vector3 } from 'three'
import { FEEL } from '../data/feel.ts'
import { gradeFor } from '../data/outlaws.ts'
import type { Actor } from '../scene/actor.ts'
import { LIFE } from '../scene/townlife.ts'
import type { DuelState, Dying, Phase } from './state.ts'

const V = (x = 0, y = 0, z = 0): Vector3 => new Vector3(x, y, z)

/** When each actor was last hit (realTime), so a hit is dressed once whoever calls it. */
const hitAt = new WeakMap<Actor, number>()
const styled = new WeakSet<Dying>()

/** Dust, cloth and a spark where the round lands; the camera feels it. */
// biome-ignore lint/complexity/useMaxParams: the outcome hook's agreed signature (who, where, which way, lethal)
export function hitFx(
  s: DuelState,
  victim: Actor,
  at: Vector3,
  away: Vector3,
  lethal: boolean,
): void {
  const last = hitAt.get(victim)
  if (last !== undefined && s.realTime - last < 0.5) {
    return
  }
  hitAt.set(victim, s.realTime)
  const c = s.c
  // dust beaten out of his coat, blown out behind him along the shot (read against the street)
  c.puffs.emit(at, 26, {
    speed: 1.4,
    size: 0.26,
    grow: 1.6,
    life: 1.3,
    color: 0xd8_c8_ae,
    alpha: 0.55,
    pop: 60,
    up: 0.12,
    spread: 0.14,
    dir: away.clone().multiplyScalar(1.6),
    drag: 3,
  })
  // and a little kicked back toward the shooter, off the front of his coat
  c.puffs.emit(at, 8, {
    speed: 0.6,
    size: 0.18,
    pop: 60,
    grow: 1.2,
    life: 0.9,
    color: 0xc8_b8_9c,
    alpha: 0.4,
    up: 0.1,
    spread: 0.1,
    dir: away.clone().multiplyScalar(-0.6),
    drag: 3.5,
  })
  // shreds of cloth, darker and quicker, fluttering down out of it
  c.puffs.emit(at, 10, {
    speed: 1.8,
    size: 0.07,
    pop: 60,
    grow: 0.1,
    life: 0.8,
    color: 0x4a_3e_34,
    alpha: 0.9,
    up: 0.4,
    spread: 0.08,
    dir: away.clone().multiplyScalar(1.4),
    drag: 2,
    rise: -3,
  })
  // the strike itself: a pinch of bright sparks, gone in a blink
  c.sparks.emit(at, lethal ? 14 : 8, {
    speed: 2.8,
    size: 0.11,
    pop: 60,
    life: 0.22,
    color: 0xff_f0_c8,
    alpha: 1,
    up: 0.2,
    spread: 0.04,
    dir: away.clone().multiplyScalar(1.5),
    drag: 4,
  })
  c.rig.addTrauma(lethal ? 0.22 : 0.16)
}

export interface Style {
  lead: 'HitRecieve' | 'HitRecieve_2' | null
  leadS: number
  rate: number
  hatFlip: boolean
}

export const DEATH_STYLES: Record<string, Style> = {
  LIGHTNING: { lead: null, leadS: 0, rate: 0.62, hatFlip: true },
  DEADEYE: { lead: null, leadS: 0, rate: 1.15, hatFlip: false },
  QUICK: { lead: 'HitRecieve', leadS: 0.22, rate: 1.0, hatFlip: false },
  STEADY: { lead: 'HitRecieve_2', leadS: 0.36, rate: 0.9, hatFlip: false },
  LUCKY: { lead: 'HitRecieve', leadS: 0.5, rate: 0.8, hatFlip: false },
}

/** A clip queued behind a stagger (game-time seconds to go). */
let pending: { actor: Actor; at: number; rate: number } | null = null
let flip: { hat: Object3D; away: Vector3; tries: number } | null = null
/** His hat, remembered while it's on his head (it's in the physics once he falls). */
let enemyHat: Object3D | null = null

/**
 * Play his death for `grade` on `s.enemy`; returns when he meets the ground (s, his clock) and
 * how much deeper the slow-mo could go (1 = as is; LIGHTNING asks for 0.6).
 */
export function deathStyle(s: DuelState, grade: string): { contact: number; slow: number } {
  const e = s.enemy
  const st = DEATH_STYLES[grade] ??
    DEATH_STYLES.LUCKY ?? { lead: null, leadS: 0, rate: 1, hatFlip: false }
  if (!e) {
    return { contact: 1, slow: 1 }
  }
  const death = e.action('Death')
  const dur = death?.getClip().duration ?? 1.2
  if (st.lead) {
    e.play(st.lead, 0.05, true, 1.3)
    pending = { actor: e, at: st.leadS, rate: st.rate }
  } else {
    e.play('Death', 0.06, true, st.rate)
    pending = null
  }
  if (st.hatFlip && enemyHat) {
    const p = s.player.root.position
    const away = V(e.root.position.x - p.x, 0, e.root.position.z - p.z).normalize()
    flip = { hat: enemyHat, away, tries: 6 }
  }
  if (s.dying) {
    styled.add(s.dying)
  }
  return { contact: st.leadS + (dur * 0.55) / st.rate, slow: st.hatFlip ? 0.6 : 1 }
}

/** Where a round from the player strikes `victim`: his chest, on the side facing the shooter. */
function chestHit(victim: Actor, from: Vector3): { at: Vector3; away: Vector3 } {
  const p = victim.root.position
  const away = V(p.x - from.x, 0, p.z - from.z).normalize()
  const at = p
    .clone()
    .add(V(0, victim.height * 0.72, 0))
    .addScaledVector(away, -0.12)
  return { at, away }
}

// ------------------------------------------------------------------------------- the watcher

let lastPhase: Phase | '' = ''
let lastLevel = -1
let lastDying: Dying | null = null
let lastFires = 0
let wisp: { actor: Actor; off: boolean; t: number; acc: number } | null = null
let weedIn = 8
const focus = V()
const tmp = V()

const TENSE = new Set<Phase>(['turn', 'wait', 'call', 'bossClock'])
/** The street holds still for the call: the town animates at 15 Hz (the tightest CPU). */
const STILL = new Set<Phase>(['turn', 'wait', 'bossClock'])
const SHOT = new Set<Phase>(['win', 'lose', 'bossWound'])
const FRESH = new Set<Phase>(['poster', 'cock', 'intro', 'title'])
const CALM = new Set<Phase>(['title', 'intro', 'poster', 'walk', 'win', 'end'])

function onPhase(s: DuelState, ph: Phase): void {
  const town = LIFE.town
  if (ph === 'call') {
    town?.call()
  } else if (SHOT.has(ph) || (ph === 'coward' && s.phaseT < 0.1)) {
    town?.shot()
  } else if (FRESH.has(ph) || ph === 'walk') {
    town?.reset()
  }
  if (ph === 'lose' && s.enemy) {
    // the camera is at your eyes: a pinch of sparks and dust out of your back, nothing in its face
    const { at, away } = chestHit(s.player, s.enemy.root.position)
    hitFx(s, s.player, at.addScaledVector(away, 0.3), away, false)
  }
}

/** A gun went off: whose muzzle was it? Keep its light off his own arm and trail its smoke. */
function onFire(s: DuelState): void {
  const c = s.c
  const at = c.flash.at
  const p = s.player
  const e = s.enemy
  if (p.muzzle(tmp).distanceTo(at) < 0.35) {
    // the flash lit his sleeve white: the light rides out ahead of the barrel, and dimmer
    const ahead = e
      ? V(e.root.position.x - at.x, 0, e.root.position.z - at.z).normalize()
      : V(0, 0, 1)
    c.world.flashLight.position.copy(at).addScaledVector(ahead, 0.9)
    c.world.flashLight.intensity = Math.min(c.world.flashLight.intensity, 16)
    wisp = { actor: p, off: false, t: 0, acc: 0 }
  } else if (e) {
    const off = e.muzzle(tmp, true).distanceTo(at) < 0.35 && e.offGun !== null
    wisp = { actor: e, off, t: 0, acc: 0 }
  }
}

function tickWisp(s: DuelState, dt: number): void {
  if (!wisp) {
    return
  }
  wisp.t += dt
  wisp.acc += dt
  if (wisp.t > 1.8) {
    wisp = null
    return
  }
  while (wisp.acc > 0.045) {
    wisp.acc -= 0.045
    s.c.puffs.emit(wisp.actor.muzzle(tmp, wisp.off), 1, {
      speed: 0.05,
      size: 0.035,
      grow: 1.6,
      life: 1.5,
      color: 0xd6_d2_ca,
      alpha: 0.2 * (1 - wisp.t / 1.8),
      up: 0.3,
      spread: 0.01,
      drag: 1.2,
      rise: 0.15,
    })
  }
}

/** The outcome code didn't dress his fall: do it here (and only once). */
function onDying(s: DuelState, d: Dying): void {
  if (d.actor === s.enemy) {
    const { at, away } = chestHit(d.actor, s.player.root.position)
    hitFx(s, d.actor, at, away, true)
  }
  if (!styled.has(d) && d.actor === s.enemy) {
    const r = deathStyle(s, gradeFor(s.lastReaction ?? 999, s.secondChance))
    d.contact = r.contact
  }
}

function tickDeath(s: DuelState, realDt: number): void {
  const dyingDt = s.timeScale > 0 ? realDt * Math.max(s.timeScale, FEEL.victimMinScale) : 0
  if (pending) {
    pending.at -= dyingDt
    if (pending.at <= 0) {
      pending.actor.play('Death', 0.12, true, pending.rate)
      pending = null
    }
  }
  if (flip && s.timeScale > 0) {
    const kicked = s.c.physics.kick(
      flip.hat,
      flip.away.clone().multiplyScalar(0.8).setY(5.2),
      V(16, 2, 3),
    )
    flip.tries--
    if (kicked || flip.tries <= 0) {
      flip = null
    }
  }
}

/** Calm phases: a tumbleweed bowls across the far street now and then. */
function tickWeeds(s: DuelState, dt: number): void {
  if (!CALM.has(s.phase)) {
    return
  }
  weedIn -= dt
  if (weedIn > 0) {
    return
  }
  weedIn = 14 + Math.random() * 16
  const tw = s.c.tumbleweeds.find((t) => !t.active)
  tw?.launch(26 + Math.random() * 20, Math.random() < 0.5 ? 1 : -1, 2.6 + Math.random() * 1.6)
}

/** Every frame, after the duel's own frame and the world's. */
export function tickLife(s: DuelState, dt: number, realDt: number): void {
  const town = LIFE.town
  const c = s.c
  if (s.phase !== lastPhase || s.level !== lastLevel) {
    if (s.level !== lastLevel && lastLevel >= 0) {
      town?.reset()
    }
    lastPhase = s.phase
    lastLevel = s.level
    onPhase(s, s.phase)
  }
  // his hat while it's on his head (kept through his fall; forgotten if he drops it at the turn)
  if (s.enemy?.hat) {
    enemyHat = s.enemy.hat
  } else if (!s.dying) {
    enemyHat = null
  }
  if (s.dying && s.dying !== lastDying) {
    onDying(s, s.dying)
  }
  lastDying = s.dying
  if (c.flash.fires !== lastFires) {
    lastFires = c.flash.fires
    onFire(s)
  }
  tickWisp(s, dt)
  tickDeath(s, realDt)
  tickWeeds(s, dt)
  tickDoors(s, realDt)
  tickCoin(s, dt)
  if (!town) {
    return
  }
  const P = s.player.root.position
  const E = s.enemy?.root.position
  focus.set(P.x, 1.5, P.z)
  if (E) {
    focus.lerp(tmp.set(E.x, 1.5, E.z), 0.5)
  }
  // new arrivals may appear on the title flyover and the hub; mid-duel they wait for the next
  town.folk.reveal = s.phase === 'title' || s.phase === 'intro' || s.phase === 'poster'
  town.update(dt, {
    focus,
    tense: TENSE.has(s.phase),
    still: STILL.has(s.phase),
    pixelRatio: c.renderer.dpr,
    dust: c.world.preset.fog,
  })
}

// --------------------------------------------------------------------------- visible fakes

let bang = -1

/** The saloon's batwings bang open and swing themselves still. */
export function bangDoors(): void {
  bang = 0
}

function tickDoors(s: DuelState, realDt: number): void {
  if (bang < 0) {
    return
  }
  bang += realDt
  if (bang > 2.4) {
    bang = -1
    return
  }
  const swing = 1.3 * Math.exp(-bang * 2.6) * Math.cos(bang * 11) * Math.min(1, bang * 30)
  s.c.world.saloonDoors.forEach((d, i) => {
    d.rotation.y = (i === 0 ? 1 : -1) * swing
  })
}

let coinT = -1

/** The coin's in the air: catch the sun at the top of its arc, and again as it turns over. */
export function watchCoin(): void {
  coinT = 0
}

function tickCoin(s: DuelState, dt: number): void {
  if (coinT < 0 || !s.coin) {
    return
  }
  const before = coinT
  coinT += dt
  for (const at of [0.3, 0.52]) {
    if (before < at && coinT >= at) {
      s.c.glint.fire(s.coin.position)
    }
  }
  if (coinT > 1) {
    coinT = -1
  }
}
