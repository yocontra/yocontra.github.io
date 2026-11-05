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
 * One climbable ladder. Porch catwalks use the four `ROOF_WALKS`; the boxcars carry end ladders
 * on their models, so those are real too. `landing` is the walkable top surface the ladder reaches.
 */
export interface Climb {
  /** 1-based id on the wire (`climbDeck`); roof walks keep their existing indices. */
  index: number
  /** The ladder line on the ground plane (the rungs / the climb path). */
  x: number
  z: number
  /** Where the rider stands at the foot and steps off at the top. */
  bottomX: number
  bottomZ: number
  topX: number
  topZ: number
  bottom: number
  top: number
  /** The surface at the top (a catwalk, a boxcar roof). */
  landing: { x: number; z: number; w: number; d: number }
  /** The porch catwalk this ladder belongs to, if any. */
  walk: RoofWalk | null
}

/** Boxcar end ladders, built from the cover entries the scene draws. */
function boxcarClimbs(start: number): Climb[] {
  const out: Climb[] = []
  let index = start
  for (const c of TOWN.cover) {
    if (c.kind !== 'boxcar') {
      continue
    }
    const alongX = c.w >= c.d
    const L = Math.max(c.w, c.d)
    const cx = c.x + c.w / 2
    const cz = c.z + c.d / 2
    for (const e of [-1, 1] as const) {
      out.push({
        index: index++,
        x: alongX ? cx + e * (L / 2 - 0.12) : cx,
        z: alongX ? cz : cz + e * (L / 2 - 0.12),
        bottomX: alongX ? cx + e * (L / 2 + 0.5) : cx,
        bottomZ: alongX ? cz : cz + e * (L / 2 + 0.5),
        topX: alongX ? cx + e * (L / 2 - 0.7) : cx,
        topZ: alongX ? cz : cz + e * (L / 2 - 0.7),
        bottom: 0,
        top: c.top ?? 3.8,
        landing: { x: c.x, z: c.z, w: c.w, d: c.d },
        walk: null,
      })
    }
  }
  return out
}

/** Every ladder in town: porch catwalks first, then the boxcar end ladders. */
export const CLIMBS: readonly Climb[] = [
  ...ROOF_WALKS.map(
    (w): Climb => ({
      index: w.index,
      x: w.ladderX,
      z: w.ladderZ,
      bottomX: w.ladderX,
      bottomZ: w.ladderZ,
      topX: w.ladderX,
      topZ: w.ladderZ,
      bottom: 0,
      top: w.height,
      landing: { x: w.x, z: w.z, w: w.w, d: w.d },
      walk: w,
    }),
  ),
  ...boxcarClimbs(ROOF_WALKS.length + 1),
]

/** The climb for a 1-based id, or null. */
export const climbAt = (index: number): Climb | null =>
  index > 0 ? (CLIMBS.find((c) => c.index === index) ?? null) : null

/**
 * A ladder you can use from here: `dir` 1 climbs up, -1 climbs down. A rider can be near either
 * end, so the height decides the direction; a catwalk's `roof` hint still wins when set.
 */
export function ladderAt(
  x: number,
  z: number,
  y: number,
  roof: number,
): { climb: Climb; dir: 1 | -1 } | null {
  let best: Climb | null = null
  let bestD = LADDER_REACH
  for (const c of CLIMBS) {
    if (roof > 0 && c.walk && c.walk.index !== roof) {
      continue
    }
    const d = Math.hypot(c.x - x, c.z - z)
    if (d < bestD) {
      best = c
      bestD = d
    }
  }
  if (!best) {
    return null
  }
  const dir: 1 | -1 = y >= best.top - 0.6 ? -1 : 1
  return { climb: best, dir }
}

/** Is (x, z) on this walk's catwalk (the centre point, before the capsule radius)? */
export function onRoofWalk(w: RoofWalk, x: number, z: number): boolean {
  return x >= w.x && x <= w.x + w.w && z >= w.z && z <= w.z + w.d
}
