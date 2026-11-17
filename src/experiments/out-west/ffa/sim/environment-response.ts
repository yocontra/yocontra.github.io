/** Accepted native shot contacts only; no client-supplied hit, damage or impulse enters here. */
import { activePropLayout, ENVIRONMENT_PROPS, propAtHit } from '../../content/environment-props.ts'
import type { StaticWorldHit } from '../../runtime/protocol.ts'
import type { ShotRay } from './combat.ts'
import { buildGrid } from './layout.ts'
import type { World } from './state.ts'

export interface PropStrike {
  hit: StaticWorldHit | null
  ray: ShotRay
  damage: number
}
export function traceEnvironment(w: World, ray: ShotRay) {
  if (w.castWorldHit) {
    const hit = w.castWorldHit(ray)
    return { range: hit?.distance ?? ray.maxT, hit }
  }
  return { range: w.castWorld?.(ray) ?? ray.maxT, hit: null }
}
/** Rebuild a world's derived surfaces only when its broken set changes; keep layout IDs intact. */
export function refreshPropGrid(w: World, previous: Uint8Array, reset = false): void {
  if (!(reset || ENVIRONMENT_PROPS.some((_, i) => (previous[i] === 0) !== (w.props[i] === 0)))) {
    return
  }
  w.grid = buildGrid(activePropLayout(w.layout, w.props))
}
/** Apply after all traces in a shell have resolved against the intact pre-shell bodies. */
export function applyPropStrikes(w: World, strikes: readonly PropStrike[]): void {
  const previous = w.props.slice()
  for (const { hit, ray, damage } of strikes) {
    const index = hit ? propAtHit(hit) : -1
    const health = w.props[index]
    if (!(hit && health && damage > 0 && Number.isFinite(damage))) {
      continue
    }
    const next = Math.max(0, Math.ceil(health - damage))
    w.props[index] = next
    if (next === 0) {
      w.events.push({
        type: 'prop_break',
        prop: index,
        tick: w.tick,
        seed: w.seed,
        point: hit.point,
        impulse: { x: ray.dx * 2, y: Math.max(0.3, ray.dy * 2), z: ray.dz * 2 },
      })
    }
  }
  const before = w.grid
  refreshPropGrid(w, previous)
  if (before !== w.grid) {
    w.propsChanged?.()
  }
}
