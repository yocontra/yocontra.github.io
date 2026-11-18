import { TICK_HZ } from '../ffa/sim/constants.ts'

// These paths and their clock match the native Frontier clip.
export const TUMBLEWEED_PERIOD = 67.105_262_756_347_66
export const MAX_KICK_OFFSET = 0.8
export const TUMBLEWEED_ROUTES = [
  // The west path passes ledge cover. Its full swept radius leaves 16 mm clearance.
  { center: [12, 54], span: [5, 1], radius: 0.35, kickLimit: 0.36 },
  { center: [39, 54], span: [2.5, 0.7], radius: 0.41, kickLimit: MAX_KICK_OFFSET },
  { center: [76, 54], span: [5, 1], radius: 0.47, kickLimit: MAX_KICK_OFFSET },
] as const

export const KICK_LIFETIME = 3.5 * TICK_HZ
const RETURN_RATE = 2
const SETTLE_SECONDS = 0.5
const MAX_KICK_SPEED = 3.5
export const TUMBLEWEED_COUNT = TUMBLEWEED_ROUTES.length

/** A single damped motion record for one weed. Replaced atomically on a later strike. */
export interface TumbleweedKick {
  tick: number
  x: number
  z: number
  vx: number
  vz: number
}

const REST = { x: 0, z: 0, vx: 0, vz: 0 }

export function tumbleweedOffset(kick: TumbleweedKick | null | undefined, sampleTick: number) {
  const age = kick ? sampleTick - kick.tick : 0
  if (!kick || age < 0 || age >= KICK_LIFETIME) {
    return REST
  }
  const t = age / TICK_HZ
  const decay = Math.exp(-t * RETURN_RATE)
  // Ease the final few millimetres to zero instead of snapping at the expiry tick.
  const tail = Math.min(1, (KICK_LIFETIME - age) / (SETTLE_SECONDS * TICK_HZ))
  const settle = tail * tail * (3 - 2 * tail)
  const settleVelocity = (-6 * tail * (1 - tail)) / SETTLE_SECONDS
  const baseline = (1 + RETURN_RATE * t) * decay
  const velocity = (1 - RETURN_RATE * t) * decay
  const position = t * decay
  const spring = -RETURN_RATE * RETURN_RATE * position
  const x = kick.x * baseline + kick.vx * position
  const z = kick.z * baseline + kick.vz * position
  return {
    x: x * settle,
    z: z * settle,
    vx: (kick.x * spring + kick.vx * velocity) * settle + x * settleVelocity,
    vz: (kick.z * spring + kick.vz * velocity) * settle + z * settleVelocity,
  }
}

export function tumbleweedTime(tick: number) {
  return (Math.max(0, tick) / TICK_HZ) % TUMBLEWEED_PERIOD
}

export function tumbleweedCenter(route: (typeof TUMBLEWEED_ROUTES)[number], tick: number) {
  const angle = (tumbleweedTime(tick) / TUMBLEWEED_PERIOD) * Math.PI * 2
  return {
    x: route.center[0] + Math.cos(angle) * route.span[0],
    y: route.radius,
    z: route.center[1] + Math.sin(angle) * route.span[1],
  }
}

function kickSpeedLimit(limit: number, x: number, z: number): number {
  const available = Math.max(0, limit - Math.hypot(x, z))
  // t*exp(-d*t) peaks at 1/(d*e). The starting offset only shrinks.
  return Math.min(MAX_KICK_SPEED, available * RETURN_RATE * Math.E)
}

export function pushTumbleweed(
  previous: TumbleweedKick | null,
  tick: number,
  push: { x: number; z: number },
  limit = MAX_KICK_OFFSET,
): TumbleweedKick {
  const offset = tumbleweedOffset(previous, tick)
  const vx = offset.vx + push.x
  const vz = offset.vz + push.z
  const speed = kickSpeedLimit(limit, offset.x, offset.z)
  const scale = Math.min(1, speed / (Math.hypot(vx, vz) || 1))
  return { tick, x: offset.x, z: offset.z, vx: vx * scale, vz: vz * scale }
}

export function readTumbleweedKicks(value: unknown, tick: number): (TumbleweedKick | null)[] {
  if (value === undefined) {
    return TUMBLEWEED_ROUTES.map(() => null)
  }
  if (!Array.isArray(value) || value.length !== TUMBLEWEED_COUNT) {
    throw new Error('Invalid tumbleweed state')
  }
  return TUMBLEWEED_ROUTES.map((route, index) => {
    const record: unknown = value[index]
    if (record === null) {
      return null
    }
    if (typeof record !== 'object' || !record) {
      throw new Error('Invalid tumbleweed kick')
    }
    const row = record as Record<string, unknown>
    const parsed = [row.tick, row.x, row.z, row.vx, row.vz]
    if (!parsed.every((component) => typeof component === 'number' && Number.isFinite(component))) {
      throw new Error('Invalid tumbleweed motion')
    }
    const kick = { tick: row.tick, x: row.x, z: row.z, vx: row.vx, vz: row.vz } as TumbleweedKick
    if (
      !Number.isInteger(kick.tick) ||
      kick.tick < 0 ||
      kick.tick > tick ||
      Math.hypot(kick.x, kick.z) > route.kickLimit + 1e-6 ||
      Math.hypot(kick.vx, kick.vz) > kickSpeedLimit(route.kickLimit, kick.x, kick.z) + 1e-6
    ) {
      throw new Error('Tumbleweed motion is outside town bounds')
    }
    return kick
  })
}
