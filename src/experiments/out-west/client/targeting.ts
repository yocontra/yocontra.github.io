import { Vec3 } from 'playcanvas'
import { shotRay, traceTargets } from '../ffa/sim/combat.ts'
import { isProtected, recordHistory } from '../ffa/sim/state.ts'
import { historyFlags } from '../ffa/sim/world.ts'
import type { PlayerInput } from '../runtime/protocol.ts'
import { domainInput } from './frontier-session.ts'

const from = new Vec3()
const to = new Vec3()
/** Touch auto fire uses the actual domain capsules and native Ammo occlusion, without a second hit model. */
export function aimedTarget(
  session: {
    world: import('../ffa/sim/state.ts').World
    selfSlot: number
    cameraTrace: import('./viewport.ts').GameSession['cameraTrace']
  },
  input: PlayerInput,
): number | null {
  const { world, selfSlot } = session
  const self = world.players[selfSlot]
  if (!self?.alive || self.showdown >= 0) {
    return null
  }
  const intent = domainInput(input, input.seq, world.tick)
  const ray = shotRay({ ...self, pitch: intent.pitch ?? 0 }, intent.aim)
  from.set(ray.ox, ray.oy, ray.oz)
  to.set(ray.ox + ray.dx * ray.maxT, ray.oy + ray.dy * ray.maxT, ray.oz + ray.dz * ray.maxT)
  const wall = session.cameraTrace?.(from, to)
  if (wall) {
    ray.maxT = from.distance(wall)
  }
  recordHistory(world, (rider) => historyFlags(world, rider))
  const target = traceTargets(world, self, ray, world.tick)
  const player = target ? world.players[target.id] : null
  return player && !isProtected(world, player) ? player.id : null
}
