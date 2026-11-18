import type { Building, Side } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import type { Rgb } from './frontier-geometry.ts'

function phase(id: string): number {
  let value = 0
  for (const letter of id) {
    value = Math.imul(value, 31) + letter.charCodeAt(0)
  }
  return (value & 0xff) / 40.74
}

/** Untreated road-facing boards bleach toward gray at different rates around the town. */
export function weatheredTimber({ id }: Building, tint: Rgb): Rgb {
  const exposure = 0.5 + 0.5 * Math.sin(phase(id))
  return [
    tint[0] * (0.78 - exposure * 0.1),
    tint[1] * (1 + exposure * 0.05),
    tint[2] * (1.13 + exposure * 0.12),
  ]
}

/** Windward edges bleach. Sheltered drip edges and valley bottoms hold dark runoff. */
export function weatheredShakes(building: Building, x: number, y: number, z: number): Rgb {
  const roof = building.roof
  if (!roof) {
    throw new Error('Roof weathering requires authored pitch')
  }
  const alongX = roof.axis === 'x'
  const distance = alongX ? z - building.z : x - building.x
  const span = alongX ? building.d : building.w
  const upland = Math.max(0, Math.min(1, (y - building.height) / roof.rise))
  const eave = distance < 0 || distance > span ? 1 : 0
  const side = distance < span / 2 ? 0 : Math.PI
  const sun = 0.5 + 0.5 * Math.sin(phase(building.id) + side)
  const moisture = (1 - upland) * (0.06 + eave * 0.28 * (1 - sun))
  const bleaching = eave * sun * 0.17
  return [
    0.7 * (1 - moisture + bleaching * 0.7),
    0.65 * (1 - moisture * 0.88 + bleaching),
    0.6 * (1 - moisture * 0.75 + bleaching * 1.2),
  ]
}

/** Independent exposed and sheltered eave finishes are visible from the street. */
export function weatheredEave({ id }: Building, side: Side, tint: Rgb): Rgb {
  const windward = side === 's' || side === 'w' ? 1 : 0
  const runoff = 0.5 + 0.5 * Math.sin(phase(id))
  const shade = 0.1 + runoff * (0.15 - windward * 0.07)
  return [
    tint[0] * (1 - shade),
    tint[1] * (1 - shade * 0.9 + windward * 0.05),
    tint[2] * (1 - shade * 0.74 + windward * 0.11),
  ]
}
