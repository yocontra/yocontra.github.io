/**
 * Porches, decks and interior floors: the raised wooden surfaces the sim and the scene both need.
 * Pure layout geometry, so the collision grid can be built on the server without importing the
 * renderer.
 */
import type { Building, Rect, Side, TownLayout } from './layout.ts'

/** Buildings with a boardwalk porch along their street front. */
export const PORCHED: ReadonlySet<string> = new Set([
  'saloon',
  'hotel',
  'general_store',
  'stage_line',
  'assay',
  'undertaker',
  'jail',
  'bank',
  'smithy',
])

/** Porch depth out from the wall, m (the posts stand in its outer half-metre). */
export const PORCH_DEPTH = 2
/** Top of a porch's (or the depot platform's) floor boards, m. */
export const PORCH_DECK = 0.06
/** Underside of the porch roofs, m (the posts run up to it). */
export const PORCH_ROOF = 3.1
/** Thickness of the porch roof boards, m. */
export const PORCH_ROOF_T = 0.12
/** Depth of the depot's platform out to the track, m. */
export const PLATFORM_DEPTH = 4.5
/** Top of a hollow building's floorboards, m. */
export const FLOOR_TOP = 0.03
/** Top of a real second floor's boards, m. */
export const UPPER_FLOOR = 3.3
/** Thickness of a second floor's boards, m. */
export const UPPER_FLOOR_T = 0.1

/**
 * Which side of a building faces the street (its facade): `front` when the layout says, else the
 * side facing the nearest street.
 */
export function frontOf(b: Building, layout: TownLayout): Side {
  if (b.front) {
    return b.front
  }
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  let best: Side = b.doors[0]?.side ?? 's'
  let bestD = Number.POSITIVE_INFINITY
  for (const s of layout.streets) {
    const dx = Math.max(s.x, Math.min(cx, s.x + s.w)) - cx
    const dz = Math.max(s.z, Math.min(cz, s.z + s.d)) - cz
    const d = Math.hypot(dx, dz)
    if (d < bestD) {
      bestD = d
      if (Math.abs(dx) / b.w > Math.abs(dz) / b.d) {
        best = dx > 0 ? 'e' : 'w'
      } else {
        best = dz > 0 ? 's' : 'n'
      }
    }
  }
  return best
}

/** The strip of ground `depth` metres deep along one side of a building. */
export function sideStrip(b: Rect, side: Side, depth: number): Rect {
  switch (side) {
    case 'n':
      return { x: b.x, z: b.z - depth, w: b.w, d: depth }
    case 's':
      return { x: b.x, z: b.z + b.d, w: b.w, d: depth }
    case 'e':
      return { x: b.x + b.w, z: b.z, w: depth, d: b.d }
    default:
      return { x: b.x - depth, z: b.z, w: depth, d: b.d }
  }
}

/** Every raised wooden deck outside: porches and the depot platform. */
export function decks(layout: TownLayout): Rect[] {
  const out: Rect[] = []
  for (const b of layout.buildings) {
    if (PORCHED.has(b.kind)) {
      out.push(sideStrip(b, frontOf(b, layout), PORCH_DEPTH))
    } else if (b.kind === 'depot') {
      out.push(sideStrip(b, frontOf(b, layout), PLATFORM_DEPTH))
    }
  }
  return out
}

const inside = (r: Rect, x: number, z: number): boolean =>
  x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d

/** The floor height props stand on at (x, z): a deck, a building's floorboards, or the dirt. */
export function floorHeight(layout: TownLayout, deckRects: Rect[], x: number, z: number): number {
  if (deckRects.some((r) => inside(r, x, z))) {
    return PORCH_DECK
  }
  for (const b of layout.buildings) {
    if (b.hollow && inside(b, x, z)) {
      return FLOOR_TOP
    }
  }
  return 0
}
