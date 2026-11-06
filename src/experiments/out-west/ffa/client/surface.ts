/**
 * What is underfoot and what a bullet hit, from the town layout (the same JSON the scene builds
 * from). Wood: hollow buildings' floors, the porches and the depot platform (the decks in
 * `scene/cover-kinds.ts`, shared with the scene), and the creek bridge. A bullet that stops on a
 * wall or cover hits wood, or stone and steel (the bank, the jail, the water tower, boxcars,
 * headstones, the forge), which ricochet; anything else is dirt.
 */
import { COVER_VISUALS, decks, frontOf, PORCH_DEPTH, sideStrip } from '../scene/cover-kinds.ts'
import { type BuildingKind, type Rect, TOWN, type TownLayout } from '../sim/layout.ts'

/** Masonry and iron: bullets ricochet off them. */
const STONE: ReadonlySet<BuildingKind> = new Set(['bank', 'jail', 'water_tower', 'tower'])
const WALL = 0.5
/** How close to a wall or cover a stopped bullet counts as hitting it, m. */
const NEAR = 0.8

function woodFloors(layout: TownLayout): Rect[] {
  const out: Rect[] = [layout.creek.bridge, ...decks(layout)]
  for (const b of layout.buildings) {
    if (b.hollow) {
      out.push({ x: b.x + WALL, z: b.z + WALL, w: b.w - WALL * 2, d: b.d - WALL * 2 })
    }
  }
  return out
}

const FLOORS = woodFloors(TOWN)

const inside = (r: Rect, x: number, z: number, pad = 0): boolean =>
  x >= r.x - pad && x <= r.x + r.w + pad && z >= r.z - pad && z <= r.z + r.d + pad

/** Boardwalk, porch, floorboards or bridge underfoot? */
export function onBoardwalk(x: number, z: number): boolean {
  return FLOORS.some((r) => inside(r, x, z))
}

/** What a bullet that stopped at (x, z) on a wall or cover hit. */
export function hitSurface(x: number, z: number): 'wood' | 'metal' | 'dirt' {
  for (const c of TOWN.cover) {
    if (inside(c, x, z, NEAR)) {
      return COVER_VISUALS[c.kind]?.surface === 'metal' ? 'metal' : 'wood'
    }
  }
  for (const b of TOWN.buildings) {
    if (inside(b, x, z, NEAR)) {
      return STONE.has(b.kind) ? 'metal' : 'wood'
    }
  }
  return 'dirt'
}

/**
 * Where the saloon's chatter and its piano come from: the barroom, and the front door where they
 * spill into the street.
 */
export function saloonSpots(): {
  room: { x: number; y: number; z: number }
  door: { x: number; y: number; z: number }
} | null {
  const b = TOWN.buildings.find((x) => x.kind === 'saloon')
  if (!b) {
    return null
  }
  const p = sideStrip(b, frontOf(b, TOWN), PORCH_DEPTH)
  return {
    room: { x: b.x + b.w / 2, y: 1.6, z: b.z + b.d / 2 },
    door: { x: p.x + p.w / 2, y: 1.6, z: p.z + p.d / 2 },
  }
}
