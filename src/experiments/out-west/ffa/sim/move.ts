/** Game-specific movement state and aim helpers. PlayCanvas owns movement and collisions. */
import { ANGLE_SCALE, POS_SCALE } from '../../contract/town.ts'
import { ROLL_IFRAME_TICKS, ROLL_TICKS, SLIDE_IFRAME_TICKS, SLIDE_TICKS } from './constants.ts'
import { climbAt, roofWalkAt } from './roofwalks.ts'
import type { MoveState } from './types.ts'

const STICK_MAX = 127
const STICK_DEAD_ZONE = 16
export const quantize = (v: number): number => Math.round(v * POS_SCALE) / POS_SCALE

export function aimRadians(aim: number): number {
  return (aim / ANGLE_SCALE) * Math.PI * 2
}

export function radiansToAim(rad: number): number {
  const turns = rad / (Math.PI * 2)
  return Math.round((turns - Math.floor(turns)) * ANGLE_SCALE) % ANGLE_SCALE
}

export function aimDir(aim: number): { x: number; z: number } {
  const a = aimRadians(aim)
  return { x: Math.cos(a), z: Math.sin(a) }
}

/** Clamp a stick vector to the unit disc (with a dead zone). A hacked magnitude buys nothing. */
export function stickVector(moveX: number, moveZ: number): { x: number; z: number; mag: number } {
  const len = Math.sqrt(moveX * moveX + moveZ * moveZ)
  if (len < STICK_DEAD_ZONE) {
    return { x: 0, z: 0, mag: 0 }
  }
  const mag = Math.min(1, len / STICK_MAX)
  return { x: moveX / len, z: moveZ / len, mag }
}

export const rolling = (m: MoveState): boolean => m.rollTicks > 0

/** Mid-vault: committed, can't shoot, roll or throw. (A hop is not a vault.) */
export const vaulting = (m: MoveState): boolean => m.jumpTicks > 0 && m.vaultStep > 0

/** A jump, mantle or fall in the air. */
export const airborne = (m: MoveState): boolean =>
  !m.grounded || m.fallTicks > 0 || (m.jumpTicks > 0 && m.vaultStep === 0)

/** On a ladder, committed up or down. */
export const climbing = (m: MoveState): boolean => m.climbTicks > 0

/** Falling without a jump: the animation and the fall-damage bookkeeping. */
export const falling = (m: MoveState): boolean =>
  m.fallTicks > 0 || (!m.grounded && m.jumpTicks === 0 && m.vy <= 0)

export const sliding = (m: MoveState): boolean => m.slideTicks > 0

/** True while a roll's i-frames (its first 0.25 s) or a slide's (its first 0.25 s) are active. */
export const inIframes = (m: MoveState): boolean =>
  (m.rollTicks > 0 && m.rollTicks >= ROLL_TICKS - ROLL_IFRAME_TICKS) ||
  (m.slideTicks > 0 && m.slideTicks >= SLIDE_TICKS - SLIDE_IFRAME_TICKS)

/** Stop every move in progress, settling a climb or fall onto the nearest safe level. */
export function stopMoves(m: MoveState): void {
  m.rollTicks = 0
  m.jumpTicks = 0
  m.vaultStep = 0
  m.slideTicks = 0
  m.airX = 0
  m.airZ = 0
  m.sprinting = false
  m.sprintOut = 0
  m.vy = 0
  m.mantleTicks = 0
  if (m.climbTicks > 0) {
    const c = climbAt(m.climbDeck)
    if (c) {
      m.x = m.climbDir > 0 ? c.topX : c.bottomX
      m.z = m.climbDir > 0 ? c.topZ : c.bottomZ
      m.y = m.climbDir > 0 ? c.top : c.bottom
      m.roof = m.climbDir > 0 && c.walk ? c.walk.index : 0
    }
    m.climbTicks = 0
    m.climbDeck = 0
    m.climbDir = 0
  }
  m.y = m.support
  m.grounded = true
  m.fallTicks = 0
  m.airPeakY = m.y
  const walk = roofWalkAt(m.roof)
  if (!walk) {
    m.roof = 0
  }
}

/** Death and respawn go back to the street; a showdown keeps its level. */
export function resetVertical(m: MoveState): void {
  m.y = 0
  m.roof = 0
  m.climbTicks = 0
  m.climbDeck = 0
  m.climbDir = 0
  m.fallTicks = 0
  m.fallTotal = 0
  m.fallFromX = 0
  m.fallFromZ = 0
  m.fallFromY = 0
  m.fallToX = 0
  m.fallToY = 0
  m.fallToZ = 0
  m.vy = 0
  m.grounded = true
  m.support = 0
  m.airPeakY = 0
  m.mantleTicks = 0
  m.mantleFromX = 0
  m.mantleFromY = 0
  m.mantleFromZ = 0
  m.mantleToX = 0
  m.mantleToY = 0
  m.mantleToZ = 0
  m.fallDamage = 0
}
