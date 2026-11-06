/**
 * Pure animation-state helpers for Frontier's local rider: the named states the dev animation
 * audit can hold, and the crowd's animation vocabulary for jumps, dodges and the self player.
 * No class state, so `game.ts` keeps only the loop.
 */
import {
  ANIM_CHANNEL,
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_HOP,
  ANIM_IDLE,
  ANIM_RELOAD,
  ANIM_ROLL,
  ANIM_RUN,
  ANIM_SLIDE,
  ANIM_VAULT,
  CHANNEL_NONE,
  EF_ALIVE,
  EF_HOLSTERED,
  EF_PROTECTED,
  SELF_ALIVE,
  SELF_HOLSTERED,
  SELF_IN_SHOWDOWN,
  STANCE_ADS,
  STANCE_CROUCH,
  STANCE_SPRINT,
} from '../../contract/town.ts'
import type { CrowdPlayer } from '../scene/crowd.ts'
import type { GestureKind } from '../scene/gestures.ts'
import type { MoveState } from '../sim/types.ts'

/** The one-shot gestures `__frontierAnim.set` can trigger. */
export const GESTURES: readonly GestureKind[] = ['throw', 'pickup', 'callout', 'draw', 'bank']

/** A held state: anim, stance bits, ground speed, and the move's turn off the aim (rad). */
export interface DevAnim {
  anim: number
  stance: number
  speed: number
  turn?: number
}

/** The animation audit's named states (dev hook `__frontierAnim.set`). */
export const ANIM_STATES: Record<string, DevAnim> = {
  idle: { anim: ANIM_IDLE, stance: 0, speed: 0 },
  walk: { anim: ANIM_RUN, stance: 0, speed: 1.6 },
  run: { anim: ANIM_RUN, stance: 0, speed: 5.5 },
  sprint: { anim: ANIM_RUN, stance: STANCE_SPRINT, speed: 7.6 },
  strafe: { anim: ANIM_RUN, stance: 0, speed: 5.5, turn: Math.PI / 2 },
  back: { anim: ANIM_RUN, stance: 0, speed: 5.5, turn: Math.PI },
  ads: { anim: ANIM_IDLE, stance: STANCE_ADS, speed: 0 },
  'ads-walk': { anim: ANIM_RUN, stance: STANCE_ADS, speed: 3 },
  crouch: { anim: ANIM_IDLE, stance: STANCE_CROUCH, speed: 0 },
  'crouch-walk': { anim: ANIM_RUN, stance: STANCE_CROUCH, speed: 2.9 },
  slide: { anim: ANIM_SLIDE, stance: 0, speed: 7 },
  jump: { anim: ANIM_HOP, stance: 0, speed: 5.5 },
  vault: { anim: ANIM_VAULT, stance: 0, speed: 4 },
  roll: { anim: ANIM_ROLL, stance: 0, speed: 8 },
  reload: { anim: ANIM_RELOAD, stance: 0, speed: 0 },
  channel: { anim: ANIM_CHANNEL, stance: 0, speed: 0 },
  dead: { anim: ANIM_DEAD, stance: 0, speed: 0 },
}

/** `ANIM_VAULT` or `ANIM_HOP` while one is under way, else 0. */
export function jumpAnim(jumpTicks: number, vaultStep: number): number {
  if (jumpTicks <= 0) {
    return 0
  }
  return vaultStep > 0 ? ANIM_VAULT : ANIM_HOP
}

/** A ladder or a step-off, in the crowd's animation vocabulary. */
export function verticalAnim(m: MoveState): number {
  if (m.climbTicks > 0) {
    return ANIM_VAULT
  }
  return m.fallTicks > 0 ? ANIM_HOP : 0
}

/** `ANIM_ROLL` or `ANIM_SLIDE` while one is under way, else 0. */
export function dodgeAnim(m: MoveState): number {
  if (m.rollTicks > 0) {
    return ANIM_ROLL
  }
  return m.slideTicks > 0 ? ANIM_SLIDE : 0
}

// biome-ignore lint/complexity/useMaxParams: the crowd's animation vocabulary is positional
export function ownAnim(
  flags: number,
  dodge: number,
  moving: boolean,
  reloading: boolean,
  channel: number,
  jump: number,
): number {
  if (!(flags & SELF_ALIVE)) {
    return ANIM_DEAD
  }
  if (flags & SELF_IN_SHOWDOWN) {
    return ANIM_DUEL
  }
  if (dodge !== 0) {
    return dodge
  }
  if (jump !== 0) {
    return jump
  }
  if (reloading) {
    return ANIM_RELOAD
  }
  if (channel !== CHANNEL_NONE) {
    return ANIM_CHANNEL
  }
  return moving ? ANIM_RUN : ANIM_IDLE
}

/** The self flags in remote-entity terms, for the crowd. */
export function ownFlags(selfFlags: number, prot: boolean): number {
  let f = selfFlags & SELF_ALIVE ? EF_ALIVE : 0
  if (prot) {
    f |= EF_PROTECTED
  }
  if (selfFlags & SELF_HOLSTERED) {
    f |= EF_HOLSTERED
  }
  return f
}

/** Your feet are on the move: alive, running (or reloading on the run), and not mid-roll. */
export function ownMoving(me: CrowdPlayer | undefined, rolling: boolean): boolean {
  return (
    me?.self === true &&
    !rolling &&
    (me.flags & EF_ALIVE) !== 0 &&
    me.anim !== ANIM_DUEL &&
    Math.hypot(me.vx, me.vz) > 0.3
  )
}
