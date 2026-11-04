/**
 * Movement, the roll, and collision. This is the exact step the client replays for prediction, so
 * it depends only on the move state, the input frame and the grid.
 */
import {
  ANGLE_SCALE,
  BTN_AIM,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_JUMP,
  BTN_ROLL,
  BTN_SPRINT,
  POS_SCALE,
} from '../../contract/town.ts'
import {
  ADS_SPEED_FACTOR,
  AIR_CONTROL,
  CROUCH_SPEED,
  DT,
  HOP_TICKS,
  JUMP_COOLDOWN_TICKS,
  PLAYER_RADIUS,
  ROLL_COOLDOWN_TICKS,
  ROLL_IFRAME_TICKS,
  ROLL_SPEED,
  ROLL_TICKS,
  RUN_SPEED,
  SLIDE_COOLDOWN_TICKS,
  SLIDE_END_SPEED,
  SLIDE_IFRAME_TICKS,
  SLIDE_SPEED,
  SLIDE_TICKS,
  SPRINT_CONE_DEG,
  SPRINT_LOCK_TICKS,
  SPRINT_MIN_STICK,
  SPRINT_OUT_TICKS,
  SPRINT_SPEED,
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

/** A jump in the air (not a vault). */
export const airborne = (m: MoveState): boolean => m.jumpTicks > 0 && m.vaultStep === 0

export const sliding = (m: MoveState): boolean => m.slideTicks > 0

/** True while a roll's i-frames (its first 0.25 s) or a slide's (its first 0.25 s) are active. */
export const inIframes = (m: MoveState): boolean =>
  (m.rollTicks > 0 && m.rollTicks >= ROLL_TICKS - ROLL_IFRAME_TICKS) ||
  (m.slideTicks > 0 && m.slideTicks >= SLIDE_TICKS - SLIDE_IFRAME_TICKS)

/** Stop every move in progress (death, a showdown, a respawn). */
export function stopMoves(m: MoveState): void {
  m.rollTicks = 0
  m.jumpTicks = 0
  m.vaultStep = 0
  m.slideTicks = 0
  m.airX = 0
  m.airZ = 0
  m.sprinting = false
  m.sprintOut = 0
}

const SPRINT_COS = Math.cos((SPRINT_CONE_DEG * Math.PI) / 180)
/** Whole centimetres per tick (air velocity rides the wire as i8 cm). */
const cm = (v: number): number => Math.max(-1.27, Math.min(1.27, Math.round(v * 100) / 100))

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

interface Stick {
  x: number
  z: number
  mag: number
}

/** The stick's heading as a wire angle, or the aim when it's centred. */
const heading = (stick: Stick, aim: number): number =>
  stick.mag > 0 ? radiansToAim(Math.atan2(stick.z, stick.x)) : aim

/**
 * Start a vault or a jump on a fresh `BTN_JUMP` press. A jump takes off at the slide's velocity,
 * else at what the stick and stance ask for, and keeps it in the air.
 */
// biome-ignore lint/complexity/useMaxParams: the per-tick hot path takes its state positionally
function startJump(
  grid: Grid,
  m: MoveState,
  input: MoveInput,
  stick: Stick,
  sprint: boolean,
): void {
  const dirAim = heading(stick, input.aim)
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
    const fromSlide = m.slideTicks > 0
    const slideDir = aimDir(m.slideAim)
    const v = fromSlide
      ? slideSpeed(m.slideTicks) * DT
      : groundSpeed(input.buttons, sprint) * stick.mag * DT
    m.airX = cm((fromSlide ? slideDir.x : stick.x) * v)
    m.airZ = cm((fromSlide ? slideDir.z : stick.z) * v)
  }
  m.slideTicks = 0
  m.sprinting = false
}

/** Ground speed (m/s) for this tick's stance: sprint, crouch, the sights. */
function groundSpeed(buttons: number, sprint: boolean): number {
  if (sprint) {
    return SPRINT_SPEED
  }
  const base = buttons & BTN_CROUCH ? CROUCH_SPEED : RUN_SPEED
  return buttons & BTN_AIM ? base * ADS_SPEED_FACTOR : base
}

/** Sprint holds this tick: the key, enough stick, close enough to the aim, nothing in the way. */
function canSprint(m: MoveState, input: MoveInput, stick: Stick): boolean {
  if (
    (input.buttons & BTN_SPRINT) === 0 ||
    input.buttons & (BTN_AIM | BTN_CROUCH) ||
    stick.mag < SPRINT_MIN_STICK ||
    m.sprintLock > 0
  ) {
    return false
  }
  const a = aimDir(input.aim)
  return stick.x * a.x + stick.z * a.z >= SPRINT_COS
}

const COUNTDOWNS = [
  'rollCooldown',
  'jumpCooldown',
  'slideCooldown',
  'sprintLock',
  'sprintOut',
] as const

/** Vault travel: one tick of the committed arc over the cover. */
function stepVault(grid: Grid, m: MoveState): void {
  m.jumpTicks--
  const dir = aimDir(m.vaultAim)
  slideMasked(grid, m, { dx: dir.x * m.vaultStep, dz: dir.z * m.vaultStep, except: BLOCK_VAULT })
  if (m.jumpTicks === 0) {
    m.vaultStep = 0
    // Landed: settle out of anything the last step grazed.
    slide(grid, m, 0, 0)
  }
}

/** In the air: the take-off velocity, steered a little toward the stick. */
function stepAir(grid: Grid, m: MoveState, stick: Stick): boolean {
  m.jumpTicks--
  const want = RUN_SPEED * stick.mag * DT
  m.airX = cm(m.airX + (stick.x * want - m.airX) * AIR_CONTROL)
  m.airZ = cm(m.airZ + (stick.z * want - m.airZ) * AIR_CONTROL)
  const x0 = m.x
  const z0 = m.z
  slide(grid, m, m.airX, m.airZ)
  if (m.jumpTicks === 0) {
    m.airX = 0
    m.airZ = 0
  }
  return m.x !== x0 || m.z !== z0 || stick.mag > 0
}

/** Crouch pressed mid-sprint slides; `BTN_ROLL` rolls (top-down). */
function startDodge(
  m: MoveState,
  input: MoveInput,
  stick: Stick,
  edge: (bit: number) => boolean,
): void {
  if (edge(BTN_CROUCH) && m.sprinting && m.slideCooldown === 0 && m.rollTicks === 0) {
    m.slideTicks = SLIDE_TICKS
    m.slideCooldown = SLIDE_COOLDOWN_TICKS
    m.slideAim = heading(stick, input.aim)
  }
  if (edge(BTN_ROLL) && m.rollTicks === 0 && m.rollCooldown === 0 && m.slideTicks === 0) {
    const dir = stick.mag > 0 ? stick : aimDir(input.aim)
    m.rollTicks = ROLL_TICKS
    m.rollDirX = dir.x
    m.rollDirZ = dir.z
    m.rollCooldown = ROLL_COOLDOWN_TICKS
  }
}

/** A roll or a slide in progress moves you this tick (false when neither is). */
function stepDodge(grid: Grid, m: MoveState): boolean {
  if (m.rollTicks > 0) {
    m.rollTicks--
    slide(grid, m, m.rollDirX * ROLL_SPEED * DT, m.rollDirZ * ROLL_SPEED * DT)
    return true
  }
  if (m.slideTicks > 0) {
    const v = slideSpeed(m.slideTicks) * DT
    m.slideTicks--
    const d = aimDir(m.slideAim)
    slide(grid, m, d.x * v, d.z * v)
    return true
  }
  return false
}

/**
 * Advance one tick. Returns true if the player moved under their own input (used for spread and
 * for cancelling channels).
 */
export function stepMove(grid: Grid, m: MoveState, input: MoveInput): boolean {
  for (const k of COUNTDOWNS) {
    m[k] = Math.max(0, m[k] - 1)
  }
  if (!input.canMove) {
    if (vaulting(m)) {
      // Cut short on top of the cover: step off it.
      slide(grid, m, 0, 0)
    }
    stopMoves(m)
    return false
  }
  const stick = stickVector(input.moveX, input.moveZ)
  const edge = (bit: number) => (input.buttons & bit) !== 0 && (input.prevButtons & bit) === 0
  if (input.buttons & BTN_FIRE) {
    // A trigger pull drops the sprint; the gun takes a moment to come up.
    if (m.sprinting && edge(BTN_FIRE)) {
      m.sprintOut = SPRINT_OUT_TICKS
    }
    m.sprintLock = SPRINT_LOCK_TICKS
  }
  const sprint = canSprint(m, input, stick)
  if (edge(BTN_JUMP) && m.rollTicks === 0 && m.jumpTicks === 0 && m.jumpCooldown === 0) {
    startJump(grid, m, input, stick, sprint)
  }
  if (vaulting(m)) {
    stepVault(grid, m)
    return true
  }
  if (m.jumpTicks > 0) {
    m.sprinting = sprint
    return stepAir(grid, m, stick)
  }
  startDodge(m, input, stick, edge)
  m.sprinting = false
  if (stepDodge(grid, m)) {
    return true
  }
  if (stick.mag === 0) {
    return false
  }
  m.sprinting = sprint
  const step = groundSpeed(input.buttons, sprint) * stick.mag * DT
  slide(grid, m, stick.x * step, stick.z * step)
  return true
}

/** The slide eases from `SLIDE_SPEED` to `SLIDE_END_SPEED` over its ticks (m/s). */
function slideSpeed(ticksLeft: number): number {
  const t = ticksLeft / SLIDE_TICKS
  return SLIDE_END_SPEED + (SLIDE_SPEED - SLIDE_END_SPEED) * t
}
