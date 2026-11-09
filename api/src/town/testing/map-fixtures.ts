/** Semantic locations shared by tests that use the authored town. */
import { TOWN, type ZoneKind } from '../../../../src/experiments/out-west/ffa/sim/layout.ts'

const street = TOWN.streets.find((entry) => entry.id === 'main_street')
if (!street) {
  throw new Error('The town needs its authored main street')
}

/** Ten clear metres across the street, with room to move north for rewind tests. */
export const COMBAT_LANE = {
  from: { x: street.x + street.w / 2 - 5, z: street.z + street.d * 0.75 },
  to: { x: street.x + street.w / 2 + 5, z: street.z + street.d * 0.75 },
}

export function serviceZone(kind: ZoneKind) {
  const zone = TOWN.zones.find((entry) => entry.kind === kind)
  if (!zone) {
    throw new Error(`The town needs an authored ${kind} service`)
  }
  return zone
}
