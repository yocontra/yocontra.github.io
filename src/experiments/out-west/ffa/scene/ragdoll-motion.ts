/** Cosmetic safety limits preserve the simulation's valid movement and authored fall domain. */
import {
  DT,
  GRAVITY,
  JUMP_APEX,
  JUMP_SPEED,
  MANTLE_MAX_PROBE,
  MANTLE_REACH,
  MANTLE_TICKS,
  ROLL_SPEED,
  SLIDE_SPEED,
  SPRINT_SPEED,
  VAULT_ARC_CLEARANCE,
  VAULT_MAX_M,
  VAULT_TICKS,
} from '../sim/constants.ts'
import { TOWN } from '../sim/layout.ts'
import { CLIMB_TICKS, CLIMBS } from '../sim/roofwalks.ts'

const MANTLE_SECONDS = MANTLE_TICKS * DT
const VAULT_SECONDS = VAULT_TICKS * DT
const CLIMB_SECONDS = CLIMB_TICKS * DT
// Endpoints are centimetre-quantized; their difference can add one centimetre per axis.
const ROUNDING_SPEED = 0.01 / DT
const climbHorizontal = Math.max(
  0,
  ...CLIMBS.flatMap((climb) => {
    const bottom = Math.hypot(climb.bottomX - climb.x, climb.bottomZ - climb.z)
    const top = Math.hypot(climb.topX - climb.x, climb.topZ - climb.z)
    // The last ladder tick settles onto its authored landing point, off the ladder's axis.
    return [bottom / CLIMB_SECONDS + top / DT, top / CLIMB_SECONDS + bottom / DT]
  }),
)
export const CORPSE_MAX_HORIZONTAL = Math.max(
  SPRINT_SPEED,
  SLIDE_SPEED,
  ROLL_SPEED,
  (1.5 * MANTLE_MAX_PROBE) / MANTLE_SECONDS,
  VAULT_MAX_M / VAULT_SECONDS,
  climbHorizontal + Math.SQRT2 * ROUNDING_SPEED,
)
const maxVaultHeight = Math.max(0, ...TOWN.cover.map((cover) => cover.vaultHeight ?? 0))
export const CORPSE_MAX_RISE =
  Math.max(
    JUMP_SPEED,
    (1.5 * MANTLE_REACH) / MANTLE_SECONDS,
    (4 * (maxVaultHeight + VAULT_ARC_CLEARANCE)) / VAULT_SECONDS,
    ...CLIMBS.map((climb) => Math.abs(climb.top - climb.bottom) / CLIMB_SECONDS),
  ) + ROUNDING_SPEED

const maximumSupport = Math.max(
  0,
  ...TOWN.buildings.map((building) => building.height + (building.roof?.rise ?? 0)),
  ...TOWN.cover.map((cover) => (cover.y0 ?? 0) + (cover.top ?? 0)),
  ...(TOWN.catwalks ?? []).map((walk) => walk.height),
)
// A whole additional simulation tick covers its discrete downward integration overshoot.
export const CORPSE_MAX_FALL = Math.sqrt(2 * GRAVITY * (maximumSupport + JUMP_APEX)) + GRAVITY * DT
const IMPULSE_ALLOWANCE = 4

interface Velocity {
  x: number
  y: number
  z: number
}

/** Bound axes independently so a valid fast fall never scales away horizontal momentum. */
export function limitCorpseVelocity(velocity: Velocity, stepping = false): void {
  if (
    !(Number.isFinite(velocity.x) && Number.isFinite(velocity.y) && Number.isFinite(velocity.z))
  ) {
    velocity.x = 0
    velocity.y = 0
    velocity.z = 0
    return
  }
  const allowance = stepping ? IMPULSE_ALLOWANCE : 0
  const horizontal = Math.hypot(velocity.x, velocity.z)
  const maxHorizontal = CORPSE_MAX_HORIZONTAL + allowance
  if (horizontal > maxHorizontal) {
    velocity.x *= maxHorizontal / horizontal
    velocity.z *= maxHorizontal / horizontal
  }
  velocity.y = Math.max(
    -CORPSE_MAX_FALL - allowance,
    Math.min(CORPSE_MAX_RISE + allowance, velocity.y),
  )
}
