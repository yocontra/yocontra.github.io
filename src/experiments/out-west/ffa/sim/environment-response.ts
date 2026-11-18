/** Accepted native shot contacts only; no client-supplied hit, damage or impulse enters here. */
import { activePropLayout, ENVIRONMENT_PROPS, propAtHit } from '../../content/environment-props.ts'
import { bucketAtHit } from '../../content/metal-buckets.ts'
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
  let previous: Uint8Array | undefined
  let buckets: Map<number, { dx: number; dz: number; damage: number }> | undefined
  for (const { hit, ray, damage } of strikes) {
    if (!(hit && damage > 0 && Number.isFinite(damage))) {
      continue
    }
    const cover = bucketAtHit(w.layout, hit)
    if (cover !== undefined) {
      buckets ??= new Map()
      const strike = buckets.get(cover)
      if (strike) {
        strike.damage += damage
      } else {
        buckets.set(cover, { dx: ray.dx, dz: ray.dz, damage })
      }
      continue
    }
    const index = propAtHit(hit)
    const health = w.props[index]
    if (!health) {
      continue
    }
    previous ??= w.props.slice()
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
  for (const [cover, strike] of buckets ?? []) {
    w.events.push({
      type: 'prop_rattle',
      cover,
      tick: w.tick,
      seed: w.seed,
      dx: strike.dx,
      dz: strike.dz,
      strength: Math.min(1, 0.25 + strike.damage / 80),
    })
  }
  if (!previous) {
    return
  }
  const before = w.grid
  refreshPropGrid(w, previous)
  if (before !== w.grid) {
    w.propsChanged?.()
  }
}
