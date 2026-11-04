import type { Vector3 } from 'three'
import type { Gimmick } from '../data/outlaws.ts'
import type { Actor } from '../scene/actor.ts'
import type { DrawSpec, OffHand } from '../scene/draw.ts'
import type { DuelState } from './state.ts'

/**
 * Who draws how, on the call (scene/draw.ts animates it). Presentation only: the shot is never
 * waited on, and nothing here reads or moves a clock the judge uses.
 */

/** Your draw: on the bell, at the hip by ~170 ms, aimed by 300 ms; a press anywhere fires. */
export const PLAYER_DRAW_S = 0.3
/** The remote man (PvP, ranked): his reaction is only known when his shot lands. */
export const REMOTE_DRAW_S = 0.3
const DRAW_MIN_S = 0.24
const DRAW_MAX_S = 0.5

/** Fanners: the off hand over the hammer every shot. Everyone else steadies the grip. */
const FANNERS: ReadonlySet<Gimmick> = new Set(['impatient', 'drunk', 'cards', 'fake-king', 'drr'])

export const offHandOf = (g: Gimmick): OffHand => (FANNERS.has(g) ? 'fan' : 'steady')

/** His draw time from his planned shot (ms after the call), or his draw stat: aimed just before. */
export function drawSecs(shotInMs: number): number {
  return Math.min(DRAW_MAX_S, Math.max(DRAW_MIN_S, (shotInMs * 0.85) / 1000))
}

/**
 * The standoff's nerves (scene/gesture.ts): the gun hand hovers over the leather and he fidgets on
 * his own random clock (never the call's: nothing here can hint at it).
 */
export function standoffNerves(...men: (Actor | null)[]): void {
  for (const a of men) {
    if (a) {
      a.gestures.hover = 1
      a.gestures.fidget = 'standoff'
    }
  }
}

/** A shot that just missed him: the head snaps aside (body only: it plays under the draw). */
export function nearMiss(a: Actor): void {
  a.gestures.play('flinch')
}

/** After the twirl: a hat tip to the town, then he stands easy (the hub's variety idles). */
export function victoryTaunt(a: Actor): void {
  a.gestures.play('tipHat', 1)
  a.gestures.fidget = 'hub'
}

/** The quick-draw (and turn, if `spec.turn`): presentation only, never waits on anything. */
export function quickDraw(a: Actor, spec: DrawSpec): void {
  a.gestures.hover = 0
  a.gestures.fidget = null
  if (!a.drawing) {
    if (spec.turn) {
      a.root.rotation.y = spec.turn.to
    }
    return
  }
  a.play('Idle_Gun_Pointing', Math.min(0.3, spec.secs * 0.9))
  a.drawing.draw(spec)
}

/**
 * He fires: the gun is out and on his man this frame, kicking, and he is posed now so his
 * `muzzle` is the shot's origin. Returns true when the off hand fired (two guns take turns).
 */
export function fireGun(a: Actor): boolean {
  const off = a.drawing?.fire() ?? false
  if (a.drawing?.active) {
    a.update(0)
  } else {
    a.draw()
  }
  a.root.updateMatrixWorld(true)
  return off
}

/** After a win: twirl it on the trigger finger and holster it. */
export function spinHolster(a: Actor): void {
  if (a.drawing?.drawn) {
    a.play('Idle', 0.8)
    a.drawing.spin()
  }
}

/** The middle of a man's chest (where a duellist aims). */
function chestOf(a: Actor | null, out: Vector3): Vector3 | null {
  if (!a) {
    return null
  }
  return a.root.getWorldPosition(out).setY(a.root.position.y + a.height * 0.7)
}

/** Both men turn (backs to each other) and draw on the bell. */
export function drawOnCall(d: DuelState, enemySecs: number): void {
  const turn = d.backsTurned
  const p = d.player
  const e = d.enemy
  quickDraw(p, {
    secs: PLAYER_DRAW_S,
    turn: turn ? { from: Math.PI, to: Math.PI * 2 } : null,
    target: () => chestOf(d.enemy, p.root.position.clone()),
    off: 'steady',
  })
  if (e && d.enemyAlive) {
    quickDraw(e, {
      secs: enemySecs,
      turn: turn ? { from: 0, to: Math.PI } : null,
      target: () => chestOf(d.player, e.root.position.clone()),
      off: offHandOf(d.outlaw.gimmick),
      flourish: d.boss,
    })
  }
}

/** One man turns and draws on his own (a back-shot, an early draw): quick, from where he faces. */
export function drawAt(a: Actor, at: Actor, faceTo: number, secs: number): void {
  const from = a.root.rotation.y
  // the short way round
  const to = from + Math.atan2(Math.sin(faceTo - from), Math.cos(faceTo - from))
  quickDraw(a, {
    secs,
    turn: Math.abs(to - from) > 0.05 ? { from, to } : null,
    target: () => chestOf(at, a.root.position.clone()),
  })
}
