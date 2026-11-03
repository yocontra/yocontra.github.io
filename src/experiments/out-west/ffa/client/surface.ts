/**
 * What is underfoot and what a bullet hit, from the town layout (the same JSON the scene builds
 * from). Wood: hollow buildings' floors, the porches on the saloon, hotel, general store and stage
 * line, and the creek bridge. A bullet that stops on a wall or cover hits wood, or stone and steel
 * (the bank, the jail, boxcars, the water tower), which ricochet; anything else is dirt.
 */
import { type Building, type Rect, type Side, TOWN, type TownLayout } from '../sim/layout.ts'

/** Buildings with a porch out front (mirrors `ffa/scene/town.ts`). */
const PORCHED = new Set(['saloon', 'hotel', 'general_store', 'stage_line'])
/** Masonry and iron: bullets ricochet off them. */
const STONE = new Set(['bank', 'jail', 'water_tower'])
const PORCH_DEPTH = 2
const WALL = 0.5
/** How close to a wall or cover a stopped bullet counts as hitting it, m. */
const NEAR = 0.8

/** Which side of a building faces the nearest street (as the scene decides its front). */
function frontOf(b: Building, layout: TownLayout): Side {
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

function porch(b: Building, side: Side): Rect {
  switch (side) {
    case 'n':
      return { x: b.x, z: b.z - PORCH_DEPTH, w: b.w, d: PORCH_DEPTH }
    case 's':
      return { x: b.x, z: b.z + b.d, w: b.w, d: PORCH_DEPTH }
    case 'e':
      return { x: b.x + b.w, z: b.z, w: PORCH_DEPTH, d: b.d }
    default:
      return { x: b.x - PORCH_DEPTH, z: b.z, w: PORCH_DEPTH, d: b.d }
  }
}

function woodFloors(layout: TownLayout): Rect[] {
  const out: Rect[] = [layout.creek.bridge]
  for (const b of layout.buildings) {
    if (b.hollow) {
      out.push({ x: b.x + WALL, z: b.z + WALL, w: b.w - WALL * 2, d: b.d - WALL * 2 })
    }
    if (PORCHED.has(b.kind)) {
      out.push(porch(b, frontOf(b, layout)))
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
      return c.kind === 'boxcar' ? 'metal' : 'wood'
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
  const p = porch(b, frontOf(b, TOWN))
  return {
    room: { x: b.x + b.w / 2, y: 1.6, z: b.z + b.d / 2 },
    door: { x: p.x + p.w / 2, y: 1.6, z: p.z + p.d / 2 },
  }
}
