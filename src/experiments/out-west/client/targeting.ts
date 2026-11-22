import { Vec3 } from 'playcanvas'
import { shotRay, traceTargets } from '../ffa/sim/combat.ts'
import { isProtected, recordHistory, type World } from '../ffa/sim/state.ts'
import { historyFlags } from '../ffa/sim/world.ts'
import type { PlayerInput } from '../runtime/protocol.ts'
import { domainInput } from './frontier-session.ts'
import type { GameSession } from './viewport.ts'

const from = new Vec3()
const to = new Vec3()
const CONTROLLER_ADS_SCALE = 0.78
interface TargetingSession {
  world: World
  selfSlot: number
  cameraTrace: GameSession['cameraTrace']
}

/** Apply mild stick resistance while the current shot ray crosses a visible opponent. */
export function controllerAimScale(session: TargetingSession, input: PlayerInput): number {
  return session.cameraTrace && aimedTarget(session, input) !== null ? CONTROLLER_ADS_SCALE : 1
}

/** Touch auto fire uses the actual domain capsules and native Ammo occlusion, without a second hit model. */
export function aimedTarget(session: TargetingSession, input: PlayerInput): number | null {
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
