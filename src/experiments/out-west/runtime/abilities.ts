/** Out West movement rules. Collision/support queries are provided by PlayCanvas. */
import { ANGLE_SCALE } from '../contract/town.ts'
import { AIR_CONTROL } from '../ffa/sim/constants.ts'
import { CLIMB_TICKS, climbAt, ladderAt } from '../ffa/sim/roofwalks.ts'
import { type MoveState, makeMoveState } from '../ffa/sim/types.ts'
import { Buttons, type PlayerInput } from './protocol.ts'
export type Point = readonly [number, number, number]
export interface Hit {
  point: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
}
export type Cast = (from: Point, to: Point) => Hit | null
export interface MotorFrame {
  vx: number
  vz: number
  vy: number
  height: number
  gravity: boolean
  position?: Point
}
const step = 0.05
const cooldowns = [
  'rollCooldown',
  'jumpCooldown',
  'slideCooldown',
  'sprintLock',
  'sprintOut',
] as const
export function newMotion(x: number, y: number, z: number) {
  return { ...makeMoveState(x, z), y, airPeakY: y, support: y }
}
function forward(yaw: number) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) }
}
function angle(x: number, z: number) {
  const turns = Math.atan2(z, x) / (Math.PI * 2)
  return Math.round((turns - Math.floor(turns)) * ANGLE_SCALE)
}
function direction(aim: number) {
  const rad = (aim / ANGLE_SCALE) * Math.PI * 2
  return { x: Math.cos(rad), z: Math.sin(rad) }
}
function startTraversal(m: MoveState & { vaultArc?: number }, input: PlayerInput, cast: Cast) {
  const magnitude = Math.hypot(input.moveX, input.moveZ)
  const f =
    magnitude >= 16 / 127
      ? { x: input.moveX / magnitude, z: input.moveZ / magnitude }
      : forward(input.yaw)
  const reach = 1.2
  const aheadX = m.x + f.x * reach
  const aheadZ = m.z + f.z * reach
  const shin = cast([m.x, m.y + 0.35, m.z], [aheadX, m.y + 0.35, aheadZ])
  const obstacle = shin ?? cast([m.x, m.y + 0.9, m.z], [aheadX, m.y + 0.9, aheadZ])
  if (!obstacle) {
    return false
  }
  // Open rails have a thin top: keep the fallback probe on that actual native surface.
  const inset = shin ? 0.25 : 0.02
  const topX = obstacle.point.x + f.x * inset
  const topZ = obstacle.point.z + f.z * inset
  const top = cast([topX, m.y + 2.4, topZ], [topX, m.y + 0.25, topZ])
  if (!top || top.normal.y < 0.65) {
    return false
  }
  const y = top.point.y
  if (cast([m.x, m.y + 1.7, m.z], [aheadX, y + 1.7, aheadZ])) {
    return false
  }
  m.mantleFromX = m.x
  m.mantleFromY = m.y
  m.mantleFromZ = m.z
  m.mantleToX = topX
  m.mantleToY = y
  m.mantleToZ = topZ
  if (y - m.y <= 1.2 && magnitude >= 16 / 127) {
    const x = m.x + f.x * 2.1
    const z = m.z + f.z * 2.1
    const landing = cast([x, y + 0.2, z], [x, m.y - 0.5, z])
    if (!landing || landing.normal.y < 0.65) {
      return false
    }
    m.mantleToX = x
    m.mantleToY = landing.point.y
    m.mantleToZ = z
    m.vaultArc = y - m.y + 0.35
    m.jumpTicks = 10
    m.vaultStep = 2.1 / 10
    m.vaultAim = angle(f.x, f.z)
  } else {
    m.mantleTicks = 6
  }
  m.jumpCooldown = 14
  return true
}
function traversal(m: MoveState & { vaultArc?: number }): MotorFrame | null {
  let duration = 0
  let remaining = 0
  if (m.mantleTicks > 0) {
    duration = 6
    remaining = --m.mantleTicks
  } else if (m.jumpTicks > 0 && m.vaultStep > 0) {
    duration = 10
    remaining = --m.jumpTicks
  } else {
    return null
  }
  const progress = (duration - remaining) / duration
  const arc = Math.sin(progress * Math.PI) * (m.vaultArc ?? 0.6)
  const x = m.mantleFromX + (m.mantleToX - m.mantleFromX) * progress
  const y = m.mantleFromY + (m.mantleToY - m.mantleFromY) * progress + arc
  const z = m.mantleFromZ + (m.mantleToZ - m.mantleFromZ) * progress
  if (!remaining) {
    m.vaultStep = 0
  }
  return {
    vx: (x - m.x) / step,
    vz: (z - m.z) / step,
    vy: (y - m.y) / step,
    height: 1.2,
    gravity: false,
  }
}
function ladder(m: MoveState, input: PlayerInput, previous: number): MotorFrame | null {
  const action = Buttons.interact | Buttons.jump
  if (m.climbTicks === 0 && input.buttons & action && !(previous & action)) {
    const found = ladderAt(m.x, m.z, m.y, m.roof)
    if (found) {
      m.climbTicks = CLIMB_TICKS
      m.climbDeck = found.climb.index
      m.climbDir = found.dir
    }
  }
  if (m.climbTicks <= 0) {
    return null
  }
  const climb = climbAt(m.climbDeck)
  if (!climb) {
    m.climbTicks = 0
    return null
  }
  const progress = 1 - --m.climbTicks / CLIMB_TICKS
  const t = m.climbDir > 0 ? progress : 1 - progress
  const x = climb.bottomX + (climb.topX - climb.bottomX) * t
  const y = climb.bottom + (climb.top - climb.bottom) * t
  const z = climb.bottomZ + (climb.topZ - climb.bottomZ) * t
  if (!m.climbTicks) {
    m.roof = m.climbDir > 0 ? (climb.walk?.index ?? 0) : 0
  }
  return {
    vx: (x - m.x) / step,
    vz: (z - m.z) / step,
    vy: (y - m.y) / step,
    height: 1.8,
    gravity: false,
    position: [x, y, z],
  }
}
function locomotion(m: MoveState, input: PlayerInput, previous: number): MotorFrame {
  const magnitude = Math.hypot(input.moveX, input.moveZ)
  const norm = magnitude < 16 / 127 ? Number.POSITIVE_INFINITY : Math.max(1, magnitude)
  const x = input.moveX / norm
  const z = input.moveZ / norm
  const f = forward(input.yaw)
  const crouch = Boolean(input.buttons & Buttons.crouch)
  if (input.buttons & Buttons.fire) {
    m.sprintLock = 8
    if (m.sprinting) {
      m.sprintOut = 3
    }
  }
  const sprint =
    !(crouch || input.buttons & Buttons.aim) &&
    m.sprintLock === 0 &&
    Boolean(input.buttons & Buttons.sprint) &&
    x * f.x + z * f.z > 0.64
  if (
    crouch &&
    !(previous & Buttons.crouch) &&
    m.sprinting &&
    m.grounded &&
    m.slideCooldown === 0
  ) {
    m.slideTicks = 13
    m.slideCooldown = 32
    m.slideAim = angle(x, z)
  }
  if (
    input.buttons & Buttons.roll &&
    !(previous & Buttons.roll) &&
    m.grounded &&
    m.rollCooldown === 0
  ) {
    m.rollTicks = 7
    m.rollCooldown = 50
    m.rollDirX = magnitude >= 16 / 127 ? x : f.x
    m.rollDirZ = magnitude >= 16 / 127 ? z : f.z
  }
  m.sprinting = sprint
  let speed = 5.5
  if (crouch) {
    speed = 2.9
  }
  if (sprint) {
    speed = 7.6
  }
  if (input.buttons & Buttons.aim) {
    speed *= 0.55
  }
  let vx = x * speed
  let vz = z * speed
  let height = crouch ? 1.2 : 1.8
  if (m.rollTicks > 0) {
    m.rollTicks--
    vx = m.rollDirX * (4 / 0.35)
    vz = m.rollDirZ * (4 / 0.35)
    height = 1.2
  }
  if (m.slideTicks > 0) {
    const dir = direction(m.slideAim)
    const slideSpeed = 4 + (5.5 * m.slideTicks) / 13
    m.slideTicks--
    vx = dir.x * slideSpeed
    vz = dir.z * slideSpeed
    height = 1.2
  }
  if (!m.grounded) {
    vx = m.airX + (vx - m.airX) * AIR_CONTROL
    vz = m.airZ + (vz - m.airZ) * AIR_CONTROL
  }
  m.airX = vx
  m.airZ = vz
  return { vx, vz, vy: m.vy, height, gravity: true }
}
export function motorFrame(
  m: MoveState,
  input: PlayerInput,
  previous: number,
  cast: Cast,
): MotorFrame {
  for (const name of cooldowns) {
    m[name] = Math.max(0, m[name] - 1)
  }
  const climbing = ladder(m, input, previous)
  if (climbing) {
    return climbing
  }
  const committed = traversal(m)
  if (committed) {
    return committed
  }
  const frame = locomotion(m, input, previous)
  if (
    input.buttons & Buttons.jump &&
    !(previous & Buttons.jump) &&
    m.grounded &&
    m.jumpCooldown === 0
  ) {
    if (startTraversal(m, input, cast)) {
      return traversal(m) ?? frame
    }
    frame.vy = Math.sqrt(2 * 18 * 1.35)
    m.jumpCooldown = 14
    m.jumpTicks = 11
    m.grounded = false
  }
  if (m.jumpTicks > 0) {
    m.jumpTicks--
  }
  return frame
}
