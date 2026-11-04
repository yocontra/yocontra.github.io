/**
 * Movement, the roll, and collision. This is the exact step the client replays for prediction, so
 * it depends only on the move state, the input frame and the grid.
 */
import { ANGLE_SCALE, BTN_JUMP, BTN_ROLL, POS_SCALE } from '../../contract/town.ts'
import {
  DT,
  HOP_TICKS,
  JUMP_COOLDOWN_TICKS,
  PLAYER_RADIUS,
  ROLL_COOLDOWN_TICKS,
  ROLL_IFRAME_TICKS,
  ROLL_SPEED,
  ROLL_TICKS,
  RUN_SPEED,
  VAULT_MAX_M,
  VAULT_REACH,
  VAULT_TICKS,
} from './constants.ts'
import { BLOCK_MOVE, BLOCK_VAULT, circleBlocked, type Grid, pushOut } from './layout.ts'
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

/** Mid-vault: committed, can't shoot, roll or throw. (A hop is not a vault.) */
export const vaulting = (m: MoveState): boolean => m.jumpTicks > 0 && m.vaultStep > 0

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

interface SlideStep {
  dx: number
  dz: number
  /** Cell bits to pass through (`BLOCK_VAULT` mid-vault). */
  except: number
}

/** Slide a circle from its current spot by (dx, dz) against the grid. */
export function slide(grid: Grid, m: MoveState, dx: number, dz: number): void {
  slideMasked(grid, m, { dx, dz, except: 0 })
}

function slideMasked(grid: Grid, m: MoveState, { dx, dz, except }: SlideStep): void {
  const dist = Math.sqrt(dx * dx + dz * dz)
  const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP))
  let x = m.x
  let z = m.z
  for (let i = 0; i < steps; i++) {
    const p = pushOut(
      grid,
      { x: x + dx / steps, z: z + dz / steps, r: PLAYER_RADIUS },
      BLOCK_MOVE,
      except,
    )
    x = p.x
    z = p.z
  }
  m.x = quantize(x)
  m.z = quantize(z)
}

const VAULT_PROBE_M = 0.05
/** Land this far past the first clear spot, so the landing isn't grazing the cover. */
const VAULT_LAND_MARGIN_M = 0.1

/**
 * How far a vault from `m` along (dx, dz) travels: low cover with `BLOCK_VAULT` must start within
 * `VAULT_REACH` of the capsule, nothing solid may touch the path, and the far side must be clear
 * within `VAULT_MAX_M`. 0 when there's nothing to vault (or a wall, a building, a wagon in the way).
 * This is the whole anti-cheat: the server runs it on its own grid, so no client can vault a wall.
 */
export function vaultDistance(grid: Grid, m: MoveState, dx: number, dz: number): number {
  const at = (s: number) => ({ x: m.x + dx * s, z: m.z + dz * s, r: PLAYER_RADIUS })
  let start = -1
  for (let i = 1; i * VAULT_PROBE_M <= VAULT_REACH; i++) {
    const c = at(i * VAULT_PROBE_M)
    if (circleBlocked(grid, c, BLOCK_MOVE, BLOCK_VAULT)) {
      return 0
    }
    if (circleBlocked(grid, c, BLOCK_MOVE)) {
      start = i
      break
    }
  }
  if (start < 0) {
    return 0
  }
  for (let i = start; i * VAULT_PROBE_M <= VAULT_MAX_M; i++) {
    const c = at(i * VAULT_PROBE_M)
    if (circleBlocked(grid, c, BLOCK_MOVE, BLOCK_VAULT)) {
      return 0
    }
    if (!circleBlocked(grid, c, BLOCK_MOVE)) {
      const land = i * VAULT_PROBE_M + VAULT_LAND_MARGIN_M
      return circleBlocked(grid, at(land), BLOCK_MOVE) ? i * VAULT_PROBE_M : land
    }
  }
  return 0
}

/** Start a vault or a hop on a fresh `BTN_JUMP` press. */
function startJump(grid: Grid, m: MoveState, dirAim: number): void {
  // The direction goes through the wire's u16 angle, so a replay from a snapshot is exact.
  const dir = aimDir(dirAim)
  const d = vaultDistance(grid, m, dir.x, dir.z)
  m.jumpCooldown = JUMP_COOLDOWN_TICKS
  if (d > 0) {
    m.jumpTicks = VAULT_TICKS
    m.vaultStep = Math.ceil((d * 100) / VAULT_TICKS) / 100
    m.vaultAim = dirAim
  } else {
    m.jumpTicks = HOP_TICKS
    m.vaultStep = 0
  }
}

/**
 * Advance one tick. Returns true if the player moved under their own input (used for spread and
 * for cancelling channels).
 */
export function stepMove(grid: Grid, m: MoveState, input: MoveInput): boolean {
  if (m.rollCooldown > 0) {
    m.rollCooldown--
  }
  if (m.jumpCooldown > 0) {
    m.jumpCooldown--
  }
  if (!input.canMove) {
    m.rollTicks = 0
    if (vaulting(m)) {
      // Cut short on top of the cover: step off it.
      slide(grid, m, 0, 0)
    }
    m.jumpTicks = 0
    m.vaultStep = 0
    return false
  }
  const stick = stickVector(input.moveX, input.moveZ)
  const jumpPressed = (input.buttons & BTN_JUMP) !== 0 && (input.prevButtons & BTN_JUMP) === 0
  if (jumpPressed && m.rollTicks === 0 && m.jumpTicks === 0 && m.jumpCooldown === 0) {
    startJump(grid, m, stick.mag > 0 ? radiansToAim(Math.atan2(stick.z, stick.x)) : input.aim)
  }
  if (vaulting(m)) {
    m.jumpTicks--
    const dir = aimDir(m.vaultAim)
    slideMasked(grid, m, { dx: dir.x * m.vaultStep, dz: dir.z * m.vaultStep, except: BLOCK_VAULT })
    if (m.jumpTicks === 0) {
      m.vaultStep = 0
      // Landed: settle out of anything the last step grazed.
      slide(grid, m, 0, 0)
    }
    return true
  }
  if (m.jumpTicks > 0) {
    // A hop: purely for show, you run as usual.
    m.jumpTicks--
  }
  const rollPressed = (input.buttons & BTN_ROLL) !== 0 && (input.prevButtons & BTN_ROLL) === 0
  if (rollPressed && m.rollTicks === 0 && m.rollCooldown === 0) {
    m.jumpTicks = 0
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
