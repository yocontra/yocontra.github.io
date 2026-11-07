// biome-ignore-all lint/style/noExcessiveLinesPerFile: movement, collision, vaults, ladders and falls are one deterministic step
/**
 * Movement, the roll, and collision. This is the exact step the client replays for prediction, so
 * it depends only on the move state, the input frame and the grid.
 *
 * Vertical motion is real now: a capsule walks on the surface under it, jumps, mantles ledges,
 * falls with gravity and takes damage past three storeys. The old `roof` level is only a hint for
 * the four porch catwalks; the surface model in `surfaces.ts` is authoritative.
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
  BODY_HEIGHT,
  CROUCH_SPEED,
  DT,
  FALL_DAMAGE_CAP,
  FALL_DAMAGE_MIN,
  FALL_DAMAGE_PER_M,
  GRAVITY,
  HOP_TICKS,
  JUMP_COOLDOWN_TICKS,
  JUMP_SPEED,
  MANTLE_MAX_PROBE,
  MANTLE_REACH,
  MANTLE_TICKS,
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
  STEP_DOWN,
  STEP_UP,
  VAULT_ARC_CLEARANCE,
  VAULT_MAX_M,
  VAULT_REACH,
  VAULT_TICKS,
} from './constants.ts'
import { BLOCK_MOVE, BLOCK_VAULT, circleBlocked, type Grid } from './layout.ts'
import { CLIMB_TICKS, type Climb, climbAt, ladderAt, onRoofWalk, roofWalkAt } from './roofwalks.ts'
import {
  blockedAt,
  ceilingAt,
  pushOutVertical,
  standableSupport,
  supportAt,
  supportTop,
  topAt,
} from './surfaces.ts'
import type { MoveState } from './types.ts'

const STICK_MAX = 127
const STICK_DEAD_ZONE = 16
/** Never move further than this per collision sub-step (less than the capsule radius). */
const MAX_SUBSTEP = 0.2
const MANTLE_PROBE_STEP = 0.1

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

/** Slide a circle from its current spot by (dx, dz) against the surface model. */
export function slide(grid: Grid, m: MoveState, dx: number, dz: number): void {
  slideMasked(grid, m, { dx, dz, except: 0 })
}

function slideMasked(grid: Grid, m: MoveState, { dx, dz, except }: SlideStep): void {
  const dist = Math.sqrt(dx * dx + dz * dz)
  const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP))
  let x = m.x
  let z = m.z
  for (let i = 0; i < steps; i++) {
    const p = pushOutVertical(
      grid,
      { x: x + dx / steps, z: z + dz / steps, r: PLAYER_RADIUS },
      m.y,
      BODY_HEIGHT,
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

/** Start a climb, a mantle, a vault or a jump on a fresh `BTN_JUMP` press. */
// biome-ignore lint/complexity/useMaxParams: the per-tick hot path takes its state positionally
function startJump(
  grid: Grid,
  m: MoveState,
  input: MoveInput,
  stick: Stick,
  sprint: boolean,
): void {
  const ladder = ladderAt(m.x, m.z, m.y, m.roof)
  if (ladder) {
    startClimb(m, ladder.climb, ladder.dir)
    return
  }
  // A jump away from a catwalk's ladder is a step off: drop the deck hint and fall normally.
  m.roof = 0
  const dirAim = heading(stick, input.aim)
  const dir = aimDir(dirAim)
  const d = vaultDistance(grid, m, dir.x, dir.z)
  m.jumpCooldown = JUMP_COOLDOWN_TICKS
  // Running at low cover vaults it; stopping and tapping jump mantles onto it.
  const running = stick.mag >= 0.5
  if (d > 0 && running) {
    startVault(grid, m, dirAim, dir, d)
  } else if (tryMantle(grid, m, dirAim)) {
    return
  } else if (d > 0) {
    startVault(grid, m, dirAim, dir, d)
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
    m.vy = JUMP_SPEED
    m.grounded = false
    m.airPeakY = m.y
  }
  m.slideTicks = 0
  m.sprinting = false
}

/** Start a committed vault: a real arc over the cover, not a cosmetic camera lift. */
// biome-ignore lint/complexity/useMaxParams: the per-tick hot path takes its state positionally
function startVault(
  grid: Grid,
  m: MoveState,
  aim: number,
  dir: { x: number; z: number },
  distance: number,
): void {
  m.jumpTicks = VAULT_TICKS
  m.vaultStep = Math.ceil((distance * 100) / VAULT_TICKS) / 100
  m.vaultAim = aim
  m.fallFromY = m.y
  let peak = m.y
  for (let s = 0.2; s <= distance; s += 0.2) {
    peak = Math.max(peak, topAt(grid, m.x + dir.x * s, m.z + dir.z * s))
  }
  m.fallToY = peak + VAULT_ARC_CLEARANCE
  m.vy = 0
  m.grounded = false
}

/**
 * A ledge within `MANTLE_REACH` of the feet, with headroom and a clear landing. CoD's auto-mantle:
 * jump at a crate stack, a porch roof or a low wall and pull yourself up.
 */
function tryMantle(grid: Grid, m: MoveState, aim: number): boolean {
  const dir = aimDir(aim)
  for (let d = 0.5; d <= MANTLE_MAX_PROBE; d += MANTLE_PROBE_STEP) {
    const x = m.x + dir.x * d
    const z = m.z + dir.z * d
    const sup = supportAt(grid, x, z, m.y + MANTLE_REACH)
    if (sup.top <= m.y + STEP_UP + 1e-6 || sup.top > m.y + MANTLE_REACH + 1e-6) {
      continue
    }
    if (!standableSupport(grid, x, z, sup)) {
      continue
    }
    if (blockedAt(grid, x, z, PLAYER_RADIUS, sup.top)) {
      continue
    }
    if (ceilingAt(grid, x, z, sup.top) < sup.top + BODY_HEIGHT - 0.05) {
      continue
    }
    m.mantleTicks = MANTLE_TICKS
    m.mantleFromX = m.x
    m.mantleFromY = m.y
    m.mantleFromZ = m.z
    m.mantleToX = quantize(x)
    m.mantleToY = sup.top
    m.mantleToZ = quantize(z)
    m.jumpCooldown = JUMP_COOLDOWN_TICKS
    m.jumpTicks = 0
    m.vaultStep = 0
    m.slideTicks = 0
    m.airX = 0
    m.airZ = 0
    m.vy = 0
    m.grounded = false
    m.sprinting = false
    m.sprintOut = 0
    return true
  }
  return false
}

/** One tick of a committed mantle: up and forward, then settle on the ledge. */
function stepMantle(m: MoveState): void {
  m.mantleTicks--
  const t = 1 - m.mantleTicks / MANTLE_TICKS
  const e = t * t * (3 - 2 * t)
  m.x = quantize(m.mantleFromX + (m.mantleToX - m.mantleFromX) * e)
  m.z = quantize(m.mantleFromZ + (m.mantleToZ - m.mantleFromZ) * e)
  m.y = quantize(m.mantleFromY + (m.mantleToY - m.mantleFromY) * e)
  if (m.mantleTicks <= 0) {
    m.mantleTicks = 0
    m.x = m.mantleToX
    m.z = m.mantleToZ
    m.y = m.mantleToY
    m.grounded = true
    m.support = m.mantleToY
    m.vy = 0
    m.airPeakY = m.y
  }
}

/** Start a committed climb from one end of a ladder. */
function startClimb(m: MoveState, c: Climb, dir: 1 | -1): void {
  m.jumpCooldown = JUMP_COOLDOWN_TICKS
  m.x = dir > 0 ? c.bottomX : c.topX
  m.z = dir > 0 ? c.bottomZ : c.topZ
  m.fallFromX = m.x
  m.fallFromZ = m.z
  m.climbTicks = CLIMB_TICKS
  m.climbDeck = c.index
  m.climbDir = dir
  m.roof = 0
  m.y = dir > 0 ? c.bottom : c.top
  m.grounded = false
  m.vy = 0
  m.airPeakY = m.y
  m.rollTicks = 0
  m.jumpTicks = 0
  m.slideTicks = 0
  m.airX = 0
  m.airZ = 0
  m.sprinting = false
  m.sprintOut = 0
}

/** One tick of the ladder: straight up or down, fixed duration, no steering. */
function stepClimb(m: MoveState): void {
  const c = climbAt(m.climbDeck)
  if (!c) {
    m.climbTicks = 0
    m.climbDeck = 0
    m.climbDir = 0
    m.y = 0
    m.roof = 0
    m.grounded = true
    m.support = 0
    return
  }
  m.climbTicks--
  const t = 1 - m.climbTicks / CLIMB_TICKS
  m.x = quantize(m.fallFromX + (c.x - m.fallFromX) * t)
  m.z = quantize(m.fallFromZ + (c.z - m.fallFromZ) * t)
  m.y = quantize(
    m.climbDir > 0 ? c.bottom + (c.top - c.bottom) * t : c.top - (c.top - c.bottom) * t,
  )
  if (m.climbTicks <= 0) {
    m.climbTicks = 0
    m.x = m.climbDir > 0 ? c.topX : c.bottomX
    m.z = m.climbDir > 0 ? c.topZ : c.bottomZ
    m.y = m.climbDir > 0 ? c.top : c.bottom
    m.roof = m.climbDir > 0 && c.walk ? c.walk.index : 0
    m.climbDeck = 0
    m.climbDir = 0
    m.grounded = true
    m.support = m.y
    m.airPeakY = m.y
    m.vy = 0
  }
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
  const t = 1 - m.jumpTicks / VAULT_TICKS
  m.y = quantize(m.fallFromY + (m.fallToY - m.fallFromY) * 4 * t * (1 - t))
  m.airPeakY = Math.max(m.airPeakY, m.y)
  const dir = aimDir(m.vaultAim)
  slideMasked(grid, m, { dx: dir.x * m.vaultStep, dz: dir.z * m.vaultStep, except: BLOCK_VAULT })
  if (m.jumpTicks === 0) {
    m.vaultStep = 0
    // Landed: settle out of anything the last step grazed, onto the far side.
    slide(grid, m, 0, 0)
    const top = supportTop(grid, m.x, m.z, m.y)
    m.y = top
    m.support = top
    m.grounded = true
    m.vy = 0
    m.airPeakY = m.y
    m.fallTicks = 0
  }
}

/** In the air: gravity, take-off velocity and a little air control. */
function stepAir(grid: Grid, m: MoveState, stick: Stick): boolean {
  if (m.jumpTicks > 0) {
    m.jumpTicks--
  }
  const want = RUN_SPEED * stick.mag * DT
  m.airX = cm(m.airX + (stick.x * want - m.airX) * AIR_CONTROL)
  m.airZ = cm(m.airZ + (stick.z * want - m.airZ) * AIR_CONTROL)
  m.vy -= GRAVITY * DT
  m.y = quantize(m.y + m.vy * DT)
  m.airPeakY = Math.max(m.airPeakY, m.y)
  if (m.vy > 0) {
    const ceiling = ceilingAt(grid, m.x, m.z, m.y)
    if (m.y + BODY_HEIGHT > ceiling) {
      m.y = quantize(ceiling - BODY_HEIGHT)
      m.vy = 0
    }
  }
  const x0 = m.x
  const z0 = m.z
  slide(grid, m, m.airX, m.airZ)
  const top = supportTop(grid, m.x, m.z, m.y)
  if (m.vy <= 0 && m.y <= top + 0.02) {
    const drop = Math.max(0, m.airPeakY - top)
    if (drop > FALL_DAMAGE_MIN) {
      m.fallDamage = Math.min(
        FALL_DAMAGE_CAP,
        Math.round((drop - FALL_DAMAGE_MIN) * FALL_DAMAGE_PER_M),
      )
    }
    m.y = top
    m.support = top
    m.grounded = true
    m.vy = 0
    m.jumpTicks = 0
    m.airX = 0
    m.airZ = 0
    m.fallTicks = 0
    m.airPeakY = m.y
  } else {
    m.fallTicks = 1
  }
  return m.x !== x0 || m.z !== z0 || stick.mag > 0 || !m.grounded
}

/** Settle the feet on the surface under them, or start falling off a ledge. */
function settleGround(grid: Grid, m: MoveState): void {
  const top = supportTop(grid, m.x, m.z, m.y)
  if (top < m.y - STEP_DOWN) {
    m.grounded = false
    m.vy = 0
    m.fallTicks = 1
    m.airPeakY = m.y
    return
  }
  m.y = top
  m.support = top
  m.grounded = true
  m.fallTicks = 0
  if (m.roof > 0) {
    const w = roofWalkAt(m.roof)
    if (!(w && onRoofWalk(w, m.x, m.z))) {
      m.roof = 0
    }
  }
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
  // Older snapshots and test fixtures may predate the vertical fields; treat them as grounded.
  m.vy ??= 0
  m.grounded ??= true
  m.support ??= m.y
  m.airPeakY ??= m.y
  m.mantleTicks ??= 0
  m.fallDamage = 0
  for (const k of COUNTDOWNS) {
    m[k] = Math.max(0, m[k] - 1)
  }
  if (!input.canMove) {
    if (vaulting(m)) {
      slide(grid, m, 0, 0)
    }
    stopMoves(m)
    return false
  }
  if (m.climbTicks > 0) {
    stepClimb(m)
    return false
  }
  if (m.mantleTicks > 0) {
    stepMantle(m)
    return true
  }
  const stick = stickVector(input.moveX, input.moveZ)
  const edge = (bit: number) => (input.buttons & bit) !== 0 && (input.prevButtons & bit) === 0
  if (input.buttons & BTN_FIRE) {
    if (m.sprinting && edge(BTN_FIRE)) {
      m.sprintOut = SPRINT_OUT_TICKS
    }
    m.sprintLock = SPRINT_LOCK_TICKS
  }
  const sprint = canSprint(m, input, stick)
  if (edge(BTN_JUMP) && m.rollTicks === 0 && m.jumpTicks === 0 && m.jumpCooldown === 0) {
    startJump(grid, m, input, stick, sprint)
    if (m.climbTicks > 0) {
      return false
    }
    if (m.mantleTicks > 0) {
      stepMantle(m)
      return true
    }
  }
  if (vaulting(m)) {
    stepVault(grid, m)
    return true
  }
  if (!m.grounded) {
    m.sprinting = sprint
    return stepAir(grid, m, stick)
  }
  settleGround(grid, m)
  if (!m.grounded) {
    m.sprinting = sprint
    return stepAir(grid, m, stick)
  }
  startDodge(m, input, stick, edge)
  m.sprinting = false
  if (stepDodge(grid, m)) {
    settleGround(grid, m)
    return true
  }
  if (stick.mag === 0) {
    return false
  }
  m.sprinting = sprint
  const step = groundSpeed(input.buttons, sprint) * stick.mag * DT
  slide(grid, m, stick.x * step, stick.z * step)
  settleGround(grid, m)
  return true
}

/** The slide eases from `SLIDE_SPEED` to `SLIDE_END_SPEED` over its ticks (m/s). */
function slideSpeed(ticksLeft: number): number {
  const t = ticksLeft / SLIDE_TICKS
  return SLIDE_END_SPEED + (SLIDE_SPEED - SLIDE_END_SPEED) * t
}
