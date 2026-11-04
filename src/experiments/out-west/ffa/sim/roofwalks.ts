/**
 * Rooftop walkways on Perdition's porch roofs. Every walk is a narrow catwalk on top of an
 * existing two-metre porch roof, outside the building footprint, so a rider above the street is
 * still on the collision grid's open ground from below: 2D shots, bags and bots keep working
 * exactly as they do at street level.
 *
 * Both the sim and the scene read this table. The sim owns the deck rectangle and the ladder
 * point; the scene builds the ladder, the plank catwalk and (on one-storey fronts) a handrail.
 */
import { type Rect, type Side, TOWN } from './layout.ts'

/** Metres: top of the porch roof (PORCH_ROOF 3.1) plus the catwalk boards. */
export const ROOF_DECK_Y = 3.18
/** A porch's depth out from the wall, matching `PORCH_DEPTH` in the scene. */
const PORCH_DEPTH = 2
/** Keep the walk a little inside the roof's eaves and fascia. */
const EDGE = 0.15
/** Ladder foot/top, this far in from the eave. */
const LADDER_IN = 0.55
/** How close you must stand to a ladder to use it, m. */
export const LADDER_REACH = 1.1
/** Full climb, up or down. */
export const CLIMB_TICKS = 16
/** A deliberate step off the roof: a short committed fall. */
export const FALL_TICKS = 11
/** How far a step-off carries you, m. */
export const FALL_DISTANCE = 2.8

export interface RoofWalk {
  /** 1-based walking level: 0 is the street, `index + 1` this deck. */
  index: number
  id: string
  /** The building whose porch carries the walk. */
  building: string
  side: Side
  /** The deck's walkable rectangle, metres. */
  x: number
  z: number
  w: number
  d: number
  /** Deck top, metres. */
  height: number
  /** The single point where the ladder meets the ground and the deck. */
  ladderX: number
  ladderZ: number
  /** The building's storey count, so the scene knows whether it already has a porch rail. */
  floors: number
}

/** One porch roof turned into a catwalk. `along` is the ladder's offset along the front wall. */
function walk(building: string, side: Side, along: number, index: number): RoofWalk {
  const b = TOWN.buildings.find((q) => q.id === building)
  if (!b) {
    throw new Error(`roof walk: no building ${building}`)
  }
  const horizontal = side === 'n' || side === 's'
  const strip = sideStrip(b, side, PORCH_DEPTH)
  const deck: Rect = horizontal
    ? {
        x: b.x + EDGE,
        z: strip.z + EDGE,
        w: b.w - 2 * EDGE,
        d: strip.d - 2 * EDGE,
      }
    : {
        x: strip.x + EDGE,
        z: b.z + EDGE,
        w: strip.w - 2 * EDGE,
        d: b.d - 2 * EDGE,
      }
  const ladderX = horizontal
    ? b.x + along
    : strip.x + (side === 'e' ? PORCH_DEPTH - LADDER_IN : LADDER_IN)
  const ladderZ = horizontal
    ? strip.z + (side === 's' ? PORCH_DEPTH - LADDER_IN : LADDER_IN)
    : b.z + along
  return {
    index,
    id: `${building}-roof`,
    building,
    side,
    x: deck.x,
    z: deck.z,
    w: deck.w,
    d: deck.d,
    height: ROOF_DECK_Y,
    ladderX,
    ladderZ,
    floors: b.floors,
  }
}

/** The strip of ground `depth` metres out from one side of a building. */
function sideStrip(b: Rect, side: Side, depth: number): Rect {
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

/**
 * The four porch roofs a rider can reach. The ladder points sit between porch posts, clear of
 * both doorways and cover; `sim-roof.test.ts` checks the ground under each foot is walkable.
 */
export const ROOF_WALKS: readonly RoofWalk[] = [
  walk('saloon', 's', 2.5, 1),
  walk('hotel', 's', 2, 2),
  walk('general_store', 'n', 2.25, 3),
  walk('jail', 'n', 2, 4),
]

/** The walk for a 1-based level (0 = street), or null. */
export const roofWalkAt = (level: number): RoofWalk | null =>
  level > 0 ? (ROOF_WALKS[level - 1] ?? null) : null

/**
 * A ladder you can use from here: `dir` 1 climbs from the street, -1 from the roof. The caller
 * already knows whether it is on a roof, because the two ends sit on the same ground point.
 */
export function ladderAt(
  x: number,
  z: number,
  roof: number,
): { walk: RoofWalk; dir: 1 | -1 } | null {
  let best: RoofWalk | null = null
  let bestD = LADDER_REACH
  for (const w of ROOF_WALKS) {
    if (roof > 0 && w.index !== roof) {
      continue
    }
    const d = Math.hypot(w.ladderX - x, w.ladderZ - z)
    if (d < bestD) {
      best = w
      bestD = d
    }
  }
  return best ? { walk: best, dir: roof > 0 ? -1 : 1 } : null
}

/** Is (x, z) on this walk's catwalk (the centre point, before the capsule radius)? */
export function onRoofWalk(w: RoofWalk, x: number, z: number): boolean {
  return x >= w.x && x <= w.x + w.w && z >= w.z && z <= w.z + w.d
}
