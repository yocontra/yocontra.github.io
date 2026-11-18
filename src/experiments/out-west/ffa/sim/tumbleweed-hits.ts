import {
  KICK_LIFETIME,
  MAX_KICK_OFFSET,
  pushTumbleweed,
  TUMBLEWEED_ROUTES,
  type TumbleweedKick,
  tumbleweedCenter,
  tumbleweedOffset,
} from '../../contract/tumbleweed-motion.ts'
import type { ShotRay } from './combat.ts'
import type { World } from './state.ts'

interface WeedWorld extends Pick<World, 'tick' | 'castWorld'> {
  tumbleweeds: (TumbleweedKick | null)[]
}

interface WeedShot {
  ray: ShotRay
  range: number
}

function crossesSphere(
  shot: WeedShot,
  center: { x: number; y: number; z: number },
  radius: number,
): boolean {
  const { ray, range } = shot
  const dx = center.x - ray.ox
  const dy = center.y - ray.oy
  const dz = center.z - ray.oz
  const nearest = Math.max(0, Math.min(range, dx * ray.dx + dy * ray.dy + dz * ray.dz))
  return Math.hypot(dx - nearest * ray.dx, dy - nearest * ray.dy, dz - nearest * ray.dz) <= radius
}

function openDirection(
  world: WeedWorld,
  center: { x: number; y: number; z: number },
  radius: number,
  direction: { x: number; z: number },
): number {
  const cast = world.castWorld
  if (!cast) {
    return 1
  }
  const maxT = MAX_KICK_OFFSET + radius
  const ray = {
    ox: center.x,
    oy: center.y,
    oz: center.z,
    dx: direction.x,
    dy: 0,
    dz: direction.z,
    maxT,
  }
  const offsets = [-radius * 0.72, 0, radius * 0.72]
  const clearance = Math.min(
    ...offsets.map(
      (offset) =>
        cast({ ...ray, ox: ray.ox - ray.dz * offset, oz: ray.oz + ray.dx * offset }) ?? maxT,
    ),
  )
  return Math.max(0, (clearance - radius) / MAX_KICK_OFFSET)
}

/** Trace only accepted bullet segments. A light weed deflects but does not stop the shot. */
export function strikeTumbleweeds(world: WeedWorld, shots: readonly WeedShot[], viewTick: number) {
  for (const [index, route] of TUMBLEWEED_ROUTES.entries()) {
    const kick = world.tumbleweeds[index] ?? null
    const routePoint = tumbleweedCenter(route, viewTick)
    const offset = tumbleweedOffset(kick, viewTick)
    const previous = { x: routePoint.x + offset.x, y: routePoint.y, z: routePoint.z + offset.z }
    let x = 0
    let z = 0
    let hits = 0
    for (const shot of shots) {
      if (crossesSphere(shot, previous, route.radius)) {
        x += shot.ray.dx
        z += shot.ray.dz
        hits++
      }
    }
    const horizontal = Math.hypot(x, z)
    if (horizontal <= 1e-6) {
      continue
    }
    const direction = { x: x / horizontal, z: z / horizontal }
    const atImpact = tumbleweedCenter(route, world.tick)
    const now = tumbleweedOffset(kick, world.tick)
    atImpact.x += now.x
    atImpact.z += now.z
    const force =
      Math.min(3.5, (2.7 * horizontal) / hits) *
      openDirection(world, atImpact, route.radius, direction)
    if (force > 0) {
      world.tumbleweeds[index] = pushTumbleweed(
        kick,
        world.tick,
        { x: direction.x * force, z: direction.z * force },
        route.kickLimit,
      )
    }
  }
}

export function clearSettledTumbleweeds(world: WeedWorld): void {
  for (const [index, kick] of world.tumbleweeds.entries()) {
    if (kick && world.tick - kick.tick >= KICK_LIFETIME) {
      world.tumbleweeds[index] = null
    }
  }
}
