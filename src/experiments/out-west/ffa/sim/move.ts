/**
 * Movement, the roll, and collision. This is the exact step the client replays for prediction, so
 * it depends only on the move state, the input frame and the grid.
 */
import { ANGLE_SCALE, BTN_ROLL, POS_SCALE } from '../../contract/town.ts'
import {
  DT,
  PLAYER_RADIUS,
  ROLL_COOLDOWN_TICKS,
  ROLL_IFRAME_TICKS,
  ROLL_SPEED,
  ROLL_TICKS,
  RUN_SPEED,
} from './constants.ts'
import { BLOCK_MOVE, type Grid, pushOut } from './layout.ts'
import type { MoveState } from './types.ts'

const STICK_MAX = 127
const STICK_DEAD_ZONE = 16
/** Never move further than this per collision sub-step (less than the capsule radius). */
const MAX_SUBSTEP = 0.2

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

/** True while the roll's i-frames are active (the first 0.25 s of the 0.35 s roll). */
export const inIframes = (m: MoveState): boolean => m.rollTicks >= ROLL_TICKS - ROLL_IFRAME_TICKS

export interface MoveInput {
  moveX: number
  moveZ: number
  aim: number
  buttons: number
  prevButtons: number
  /** False while dead, frozen in a showdown, or lingering after a disconnect. */
  canMove: boolean
}

/** Slide a circle from its current spot by (dx, dz) against the grid. */
export function slide(grid: Grid, m: MoveState, dx: number, dz: number): void {
  const dist = Math.sqrt(dx * dx + dz * dz)
  const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP))
  let x = m.x
  let z = m.z
  for (let i = 0; i < steps; i++) {
    const p = pushOut(grid, x + dx / steps, z + dz / steps, PLAYER_RADIUS, BLOCK_MOVE)
    x = p.x
    z = p.z
  }
  m.x = quantize(x)
  m.z = quantize(z)
}

/**
 * Advance one tick. Returns true if the player moved under their own input (used for spread and
 * for cancelling channels).
 */
export function stepMove(grid: Grid, m: MoveState, input: MoveInput): boolean {
  if (m.rollCooldown > 0) {
    m.rollCooldown--
  }
  if (!input.canMove) {
    m.rollTicks = 0
    return false
  }
  const stick = stickVector(input.moveX, input.moveZ)
  const rollPressed = (input.buttons & BTN_ROLL) !== 0 && (input.prevButtons & BTN_ROLL) === 0
  if (rollPressed && m.rollTicks === 0 && m.rollCooldown === 0) {
    const dir = stick.mag > 0 ? stick : aimDir(input.aim)
    m.rollTicks = ROLL_TICKS
    m.rollDirX = dir.x
    m.rollDirZ = dir.z
    m.rollCooldown = ROLL_COOLDOWN_TICKS
  }
  if (m.rollTicks > 0) {
    m.rollTicks--
    slide(grid, m, m.rollDirX * ROLL_SPEED * DT, m.rollDirZ * ROLL_SPEED * DT)
    return true
  }
  if (stick.mag === 0) {
    return false
  }
  const step = RUN_SPEED * stick.mag * DT
  slide(grid, m, stick.x * step, stick.z * step)
  return true
}
