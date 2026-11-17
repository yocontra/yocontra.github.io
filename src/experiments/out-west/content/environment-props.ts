/** Exact eight canonical barrel bindings; no name/material heuristic determines ownership. */

import type { TownLayout } from '../ffa/sim/layout.ts'
import type { StaticWorldHit } from '../runtime/protocol.ts'
import recipe from './environment-props.json' with { type: 'json' }

export const PROP_HEALTH = 68
export const ENVIRONMENT_PROPS = recipe.props
export function initialPropHealth(layout: TownLayout): Uint8Array {
  return new Uint8Array(
    ENVIRONMENT_PROPS.map((prop) => {
      const cover = layout.cover[prop.cover]
      return cover?.kind === 'barrels' &&
        cover.x === Math.floor(prop.x) &&
        cover.z === Math.floor(prop.z) &&
        cover.w === 1 &&
        cover.d === 1 &&
        cover.top === 0.95 &&
        !cover.y0
        ? PROP_HEALTH
        : 0
    }),
  )
}
export function decodePropHealth(value: unknown): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length !== ENVIRONMENT_PROPS.length ||
    value.some((health) => !Number.isInteger(health) || health < 0 || health > PROP_HEALTH)
  ) {
    throw new Error('Invalid town props')
  }
  return new Uint8Array(value)
}
export function activePropLayout(layout: TownLayout, health: Uint8Array): TownLayout {
  return {
    ...layout,
    cover: layout.cover.flatMap((cover, index) => {
      const props = ENVIRONMENT_PROPS.filter((prop) => prop.cover === index)
      if (props.length === 0) {
        return [cover]
      }
      return props
        .filter((prop) => health[ENVIRONMENT_PROPS.indexOf(prop)] !== 0)
        .map((prop) => ({ ...cover, x: prop.x, z: prop.z, w: 0.5, d: 0.5 }))
    }),
  }
}
/** Identify a bounded authored cell from the actual native hit, never from a client target. */
export function propAtHit(hit: StaticWorldHit): number {
  const exact = ENVIRONMENT_PROPS.findIndex((prop) => prop.id === hit.collider.id)
  if (exact >= 0) {
    return exact
  }
  const first = ENVIRONMENT_PROPS.find((prop) => `cover:${prop.cover}` === hit.collider.id)
  if (!first) {
    return -1
  }
  const baseX = Math.floor(first.x)
  const baseZ = Math.floor(first.z)
  const { x, y, z } = hit.point
  // Native ownership is authoritative. Bullet can report an oblique box contact just outside
  // its nominal AABB; a second analytic tolerance must not discard that accepted native hit.
  if (![x, y, z].every(Number.isFinite)) {
    return -1
  }
  const cellX = baseX + Math.min(1, Math.max(0, Math.floor((x - baseX) * 2))) * 0.5
  const cellZ = baseZ + Math.min(1, Math.max(0, Math.floor((z - baseZ) * 2))) * 0.5
  return ENVIRONMENT_PROPS.findIndex(
    (prop) => prop.cover === first.cover && prop.x === cellX && prop.z === cellZ,
  )
}
export function propOwner(node: { name: string; parent?: { name: string } | null }): boolean {
  let current: typeof node | null | undefined = node
  while (current) {
    if (ENVIRONMENT_PROPS.some((prop) => prop.root === current?.name)) {
      return true
    }
    current = current.parent
  }
  return false
}
