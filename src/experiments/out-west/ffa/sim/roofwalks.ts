/** Native porch decks share the authored town rectangles. Their real access is the building
 * stairs; only ladders present on native vehicle models expose the ladder ability. */
import { type Side, TOWN } from './layout.ts'

export const ROOF_DECK_Y = 3.18
export const LADDER_REACH = 1.1
export const CLIMB_TICKS = 16
export const FALL_TICKS = 11
export const FALL_DISTANCE = 2.8

export interface RoofWalk {
  index: number
  id: string
  building: string
  side: Side
  x: number
  z: number
  w: number
  d: number
  height: number
  floors: number
}

const PORCH_BUILDINGS = ['saloon', 'hotel', 'general_store', 'jail'] as const
/** The canonical decks are baked and collided directly from these same layout entries. */
export const ROOF_WALKS: readonly RoofWalk[] = (TOWN.catwalks ?? []).map((deck, index) => {
  const id = PORCH_BUILDINGS[index]
  const building = TOWN.buildings.find((candidate) => candidate.id === id)
  if (!building) {
    throw new Error(`roof walk: missing building ${id}`)
  }
  return {
    ...deck,
    index: index + 1,
    id: `${building.id}-roof`,
    building: building.id,
    side: deck.z >= building.z + building.d ? 's' : 'n',
    floors: building.floors,
  }
})

/** The walk for a 1-based level (0 = street), or null. */
export const roofWalkAt = (level: number): RoofWalk | null =>
  level > 0 ? (ROOF_WALKS[level - 1] ?? null) : null

/**
 * One climbable ladder. Native boxcars carry end ladders
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

/** Native boxcars carry end ladders. Porch decks use actual stairs, never invisible ladders. */
export const CLIMBS: readonly Climb[] = boxcarClimbs(ROOF_WALKS.length + 1)

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
