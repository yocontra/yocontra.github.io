/**
 * Every cover kind Perdition dresses: what stands there and how tall it is. `dressing.ts` builds
 * each kind to fill its collider rect exactly, and `tools/town-audit.ts` flags any cover whose kind
 * isn't here (an invisible wall) and any low cover that should carry a `vaultHeight` but doesn't.
 * No DOM, so the audit and the client's surface lookups can import it. Also the porch and deck
 * geometry the scene and the footstep lookup share.
 */
import type { Building, Rect, Side, TownLayout } from '../sim/layout.ts'

export interface CoverVisual {
  /** What stands there (the map legend, the audit). */
  what: string
  /** Height of the visual's top, m. */
  height: number
  /** Whether a rider can vault it (its layout entries then carry `vaultHeight`). */
  vault: boolean
  /** What a bullet that stops on it hits. */
  surface: 'wood' | 'metal'
}

export const COVER_VISUALS: Record<string, CoverVisual> = {
  barrels: { what: 'barrels', height: 0.95, vault: true, surface: 'wood' },
  crates: { what: 'crates', height: 0.75, vault: true, surface: 'wood' },
  crate_stack: { what: 'crates stacked high', height: 2.2, vault: false, surface: 'wood' },
  hay: { what: 'hay bales', height: 1.0, vault: true, surface: 'wood' },
  fence: { what: 'split-rail fence', height: 1.1, vault: true, surface: 'wood' },
  trough: { what: 'water trough', height: 0.7, vault: true, surface: 'wood' },
  hitch_rail: { what: 'hitching rail', height: 1.05, vault: true, surface: 'wood' },
  wagon: { what: 'farm wagon', height: 1.1, vault: true, surface: 'wood' },
  covered_wagon: { what: 'covered freight wagon', height: 3.0, vault: false, surface: 'wood' },
  freight_wagon: {
    what: 'freight wagon loaded with crates',
    height: 2.2,
    vault: false,
    surface: 'wood',
  },
  stagecoach: { what: 'stagecoach', height: 2.6, vault: false, surface: 'wood' },
  wreck: { what: 'stagecoach on its side', height: 2.1, vault: false, surface: 'wood' },
  lumber: { what: 'stacked lumber', height: 1.0, vault: true, surface: 'wood' },
  woodpile: { what: 'split firewood', height: 1.0, vault: true, surface: 'wood' },
  well: { what: 'roofed well', height: 2.6, vault: false, surface: 'wood' },
  post: { what: 'boardwalk post', height: 3.1, vault: false, surface: 'wood' },
  boxcar: { what: 'railroad boxcar', height: 3.8, vault: false, surface: 'metal' },
  buffer: { what: 'track buffer stop', height: 1.0, vault: true, surface: 'wood' },
  headstone: { what: 'headstone', height: 0.8, vault: true, surface: 'metal' },
  counter: { what: 'counter', height: 1.1, vault: true, surface: 'wood' },
  table: { what: 'table and chairs', height: 0.8, vault: true, surface: 'wood' },
  forge: { what: 'brick forge', height: 1.0, vault: false, surface: 'metal' },
  anvil: { what: 'anvil on a stump', height: 0.8, vault: true, surface: 'metal' },
  bench: { what: 'bench', height: 0.5, vault: true, surface: 'wood' },
  coffins: { what: 'coffins', height: 0.9, vault: true, surface: 'wood' },
  bridge_rail: { what: 'bridge rail', height: 1.0, vault: true, surface: 'wood' },
}

/** Buildings with a boardwalk porch along their street front (the scene and footsteps share it). */
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
/** Depth of the depot's platform out to the track, m. */
export const PLATFORM_DEPTH = 4.5
/** Top of a hollow building's floorboards, m. */
export const FLOOR_TOP = 0.03

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
