/**
 * The arenas' modules (each its own chunk, fetched when its act comes up) and the `#arena=`
 * review pin.
 */
import type { ArenaId, BuildArena } from './types.ts'

/** The arenas other than the street, each its own chunk. */
export const ARENA_MODULES: Record<
  Exclude<ArenaId, 'street'>,
  () => Promise<{ build: BuildArena }>
> = {
  depot: () => import('./depot.ts'),
  mission: () => import('./mission.ts'),
  bank: () => import('./bank.ts'),
}

/** `#arena=depot` (review and the audits): every duel, the lineup and the hub in that arena. */
export function forcedArena(): ArenaId | null {
  if (typeof location === 'undefined') {
    return null
  }
  const a = new URLSearchParams(location.hash.slice(1)).get('arena')
  return a === 'street' || (a !== null && a in ARENA_MODULES) ? (a as ArenaId) : null
}
