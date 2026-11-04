/** The ground shader's light pools, shared by the street and every arena. */
import { Vector4 } from 'three'

/** How many light pools the ground shader carries. */
export const POOLS = 24

/** Exactly {@link POOLS} pools: the first ones given, the rest switched off. */
export function padPools(pools: readonly Vector4[]): Vector4[] {
  const out = pools.slice(0, POOLS)
  while (out.length < POOLS) {
    out.push(new Vector4(0, -9999, 1, 0))
  }
  return out
}
