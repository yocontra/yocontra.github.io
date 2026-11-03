/**
 * The town layout (`ffa/town.layout.json`) and the collision grid built from it. The JSON is the
 * single source of truth: the server and the client build the same grid from it here, and the
 * Blender build and the client scene read the same file.
 */
import townJson from '../town.layout.json' with { type: 'json' }

export interface Rect {
  x: number
  z: number
  w: number
  d: number
}
export type Side = 'n' | 's' | 'e' | 'w'
export interface Door {
  side: Side
  /** Offset of the gap from the wall's west (n/s) or north (e/w) end, in metres. */
  at: number
  width: number
}
export interface Building extends Rect {
  id: string
  kind: string
  height: number
  floors: number
  /** Hollow buildings are walkable inside: 0.5 m perimeter walls with door gaps. */
  hollow: boolean
  doors: Door[]
  /** Interior partitions (hollow buildings only). */
  walls?: Rect[]
}
export interface Cover extends Rect {
  kind: string
  /** Low cover blocks movement and bullets but not sight. Tall cover (boxcars) blocks all three. */
  low: boolean
}
export interface Zone {
  id: string
  kind: 'bank' | 'stage'
  x: number
  z: number
  r: number
}
export interface SpawnPoint {
  x: number
  z: number
  interior: boolean
}
export interface Spot {
  id: string
  x: number
  z: number
}
export interface PickupSpot extends Spot {
  kind: 'rifle' | 'shotgun' | 'dynamite'
}
export interface TownLayout {
  version: number
  name: string
  size: number
  cell: number
  streets: (Rect & { id: string })[]
  creek: Rect & { banks: Rect[]; bridge: Rect }
  buildings: Building[]
  cover: Cover[]
  zones: Zone[]
  spawns: SpawnPoint[]
  strongboxes: Spot[]
  pickups: PickupSpot[]
}

export const TOWN: TownLayout = townJson as TownLayout

export const BLOCK_MOVE = 1
export const BLOCK_SHOT = 2
export const BLOCK_SIGHT = 4
const WALL = BLOCK_MOVE | BLOCK_SHOT | BLOCK_SIGHT
const WALL_THICKNESS = 0.5
const EPS = 1e-6

export interface Grid {
  /** Cells per side. */
  n: number
  cell: number
  size: number
  cells: Uint8Array
  /** Interior rect of the bank building: leaving town in here banks your carry. */
  bankArea: Rect
}

function fill(grid: Grid, r: Rect, flags: number): void {
  if (r.w <= 0 || r.d <= 0) {
    return
  }
  const c0 = Math.max(0, Math.floor((r.x + EPS) / grid.cell))
  const c1 = Math.min(grid.n - 1, Math.ceil((r.x + r.w - EPS) / grid.cell) - 1)
  const r0 = Math.max(0, Math.floor((r.z + EPS) / grid.cell))
  const r1 = Math.min(grid.n - 1, Math.ceil((r.z + r.d - EPS) / grid.cell) - 1)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * grid.n + col
      grid.cells[i] = (grid.cells[i] ?? 0) | flags
    }
  }
}

/** Split one wall segment around its door gaps. `along` is x for n/s walls, z for e/w walls. */
function wallWithGaps(b: Building, side: Side): Rect[] {
  const horizontal = side === 'n' || side === 's'
  const length = horizontal ? b.w : b.d
  const gaps = b.doors
    .filter((d) => d.side === side)
    .map((d) => [d.at, d.at + d.width] as const)
    .toSorted((p, q) => p[0] - q[0])
  const pieces: [number, number][] = []
  let start = 0
  for (const [g0, g1] of gaps) {
    if (g0 > start) {
      pieces.push([start, g0])
    }
    start = Math.max(start, g1)
  }
  if (start < length) {
    pieces.push([start, length])
  }
  return pieces.map(([a, z]) => {
    if (horizontal) {
      const zz = side === 'n' ? b.z : b.z + b.d - WALL_THICKNESS
      return { x: b.x + a, z: zz, w: z - a, d: WALL_THICKNESS }
    }
    const xx = side === 'w' ? b.x : b.x + b.w - WALL_THICKNESS
    return { x: xx, z: b.z + a, w: WALL_THICKNESS, d: z - a }
  })
}

/** Every blocking rect a building contributes. */
export function buildingWalls(b: Building): Rect[] {
  if (!b.hollow) {
    return [b]
  }
  const sides: Side[] = ['n', 's', 'e', 'w']
  return [...sides.flatMap((side) => wallWithGaps(b, side)), ...(b.walls ?? [])]
}

export function buildGrid(layout: TownLayout = TOWN): Grid {
  const n = Math.round(layout.size / layout.cell)
  const bank = layout.buildings.find((b) => b.kind === 'bank')
  const grid: Grid = {
    n,
    cell: layout.cell,
    size: layout.size,
    cells: new Uint8Array(n * n),
    bankArea: bank
      ? {
          x: bank.x + WALL_THICKNESS,
          z: bank.z + WALL_THICKNESS,
          w: bank.w - 2 * WALL_THICKNESS,
          d: bank.d - 2 * WALL_THICKNESS,
        }
      : { x: 0, z: 0, w: 0, d: 0 },
  }
  const s = layout.size
  // Map border, and the steep ground north of the creek bed.
  fill(grid, { x: 0, z: 0, w: s, d: Math.max(layout.cell, layout.creek.z) }, WALL)
  fill(grid, { x: 0, z: s - layout.cell, w: s, d: layout.cell }, WALL)
  fill(grid, { x: 0, z: 0, w: layout.cell, d: s }, WALL)
  fill(grid, { x: s - layout.cell, z: 0, w: layout.cell, d: s }, WALL)
  for (const bankEdge of layout.creek.banks) {
    fill(grid, bankEdge, BLOCK_MOVE)
  }
  for (const b of layout.buildings) {
    for (const r of buildingWalls(b)) {
      fill(grid, r, WALL)
    }
  }
  for (const c of layout.cover) {
    fill(grid, c, c.low ? BLOCK_MOVE | BLOCK_SHOT : WALL)
  }
  return grid
}

export function cellAt(grid: Grid, x: number, z: number): number {
  const col = Math.floor(x / grid.cell)
  const row = Math.floor(z / grid.cell)
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return WALL
  }
  return grid.cells[row * grid.n + col] ?? WALL
}

/** A point on the ground plane. */
export interface Point {
  x: number
  z: number
}

/** A circle on the ground plane (a player's capsule seen from above). */
export interface Circle extends Point {
  r: number
}

/** A ray from (`ox`, `oz`) along the unit direction (`dx`, `dz`), walked up to `maxDist`. */
export interface Ray {
  ox: number
  oz: number
  dx: number
  dz: number
  maxDist: number
}

/** One square cell box: its min corner (`x0`, `z0`) and side length. */
interface CellBox {
  x0: number
  z0: number
  size: number
}

export const inRect = (r: Rect, x: number, z: number): boolean =>
  x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d

/** True if a circle at (x, z) overlaps any cell with `mask`. */
export function circleBlocked(grid: Grid, { x, z, r }: Circle, mask: number): boolean {
  const c = grid.cell
  const c0 = Math.floor((x - r) / c)
  const c1 = Math.floor((x + r) / c)
  const r0 = Math.floor((z - r) / c)
  const r1 = Math.floor((z + r) / c)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if ((cellAt(grid, (col + 0.5) * c, (row + 0.5) * c) & mask) === 0) {
        continue
      }
      const nx = Math.max(col * c, Math.min(x, (col + 1) * c))
      const nz = Math.max(row * c, Math.min(z, (row + 1) * c))
      if ((x - nx) ** 2 + (z - nz) ** 2 < r * r) {
        return true
      }
    }
  }
  return false
}

/** Push point `p` (a circle of radius `r`) out of one cell box. Returns true if it moved. */
function resolveCell(p: Point, { x0: bx0, z0: bz0, size: c }: CellBox, r: number): boolean {
  const nx = Math.max(bx0, Math.min(p.x, bx0 + c))
  const nz = Math.max(bz0, Math.min(p.z, bz0 + c))
  const dx = p.x - nx
  const dz = p.z - nz
  const d2 = dx * dx + dz * dz
  if (d2 >= r * r) {
    return false
  }
  if (d2 > EPS * EPS) {
    const d = Math.sqrt(d2)
    p.x = nx + (dx / d) * r
    p.z = nz + (dz / d) * r
    return true
  }
  // Centre inside the cell: leave along the shallowest axis.
  const left = p.x - bx0
  const right = bx0 + c - p.x
  const up = p.z - bz0
  const down = bz0 + c - p.z
  const m = Math.min(left, right, up, down)
  if (m === left) {
    p.x = bx0 - r
  } else if (m === right) {
    p.x = bx0 + c + r
  } else if (m === up) {
    p.z = bz0 - r
  } else {
    p.z = bz0 + c + r
  }
  return true
}

/**
 * Push a circle out of every blocked cell it overlaps. Deterministic (fixed cell order, up to three
 * passes). Returns the resolved position.
 */
export function pushOut(grid: Grid, { x: px, z: pz, r }: Circle, mask: number): Point {
  const p = { x: px, z: pz }
  const c = grid.cell
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    const c0 = Math.floor((p.x - r) / c)
    const c1 = Math.floor((p.x + r) / c)
    const r0 = Math.floor((p.z - r) / c)
    const r1 = Math.floor((p.z + r) / c)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const blocked = (cellAt(grid, (col + 0.5) * c, (row + 0.5) * c) & mask) !== 0
        if (blocked && resolveCell(p, { x0: col * c, z0: row * c, size: c }, r)) {
          moved = true
        }
      }
    }
    if (!moved) {
      break
    }
  }
  return p
}

/**
 * Walk a ray through the grid (Amanatides–Woo DDA). Returns the distance to the first cell with
 * `mask`, or `maxDist` if none.
 */
export function rayGrid(grid: Grid, { ox, oz, dx, dz, maxDist }: Ray, mask: number): number {
  const c = grid.cell
  let col = Math.floor(ox / c)
  let row = Math.floor(oz / c)
  const stepX = dx > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(c / dx)
  const tDeltaZ = dz === 0 ? Number.POSITIVE_INFINITY : Math.abs(c / dz)
  let tMaxX =
    dx === 0 ? Number.POSITIVE_INFINITY : ((stepX > 0 ? (col + 1) * c : col * c) - ox) / dx
  let tMaxZ =
    dz === 0 ? Number.POSITIVE_INFINITY : ((stepZ > 0 ? (row + 1) * c : row * c) - oz) / dz
  let t = 0
  while (t <= maxDist) {
    if ((cellAt(grid, (col + 0.5) * c, (row + 0.5) * c) & mask) !== 0) {
      return t
    }
    if (tMaxX < tMaxZ) {
      t = tMaxX
      tMaxX += tDeltaX
      col += stepX
    } else {
      t = tMaxZ
      tMaxZ += tDeltaZ
      row += stepZ
    }
  }
  return maxDist
}

/** Line of sight between two points (only sight-blocking cells count). */
export function hasLineOfSight(
  grid: Grid,
  { x: ax, z: az }: Point,
  { x: bx, z: bz }: Point,
): boolean {
  const dx = bx - ax
  const dz = bz - az
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d < EPS) {
    return true
  }
  return rayGrid(grid, { ox: ax, oz: az, dx: dx / d, dz: dz / d, maxDist: d }, BLOCK_SIGHT) >= d
}

export function zoneAt(layout: TownLayout, x: number, z: number): Zone | null {
  for (const zone of layout.zones) {
    if ((x - zone.x) ** 2 + (z - zone.z) ** 2 <= zone.r * zone.r) {
      return zone
    }
  }
  return null
}

/** Spawns this close to the map's edge face straight in from it. */
const EDGE_SPAWN = 16

/**
 * Which way a rider faces on spawning there (radians, 0 = +x, toward +z): into town. Perimeter
 * spawns look in from their edge, leaning toward the crossroads; interior ones look at it.
 */
export function spawnFacing(p: Point, layout: TownLayout = TOWN): number {
  const main = layout.streets[0]
  const cx = main ? main.x + main.w / 2 : layout.size / 2
  const cz = main ? main.z + main.d / 2 : layout.size / 2
  let dx = cx - p.x
  let dz = cz - p.z
  const len = Math.hypot(dx, dz) || 1
  dx /= len
  dz /= len
  const s = layout.size
  const edges: [number, number, number][] = [
    [p.x, 1, 0],
    [s - p.x, -1, 0],
    [p.z - layout.creek.z, 0, 1],
    [s - p.z, 0, -1],
  ]
  const [d, nx, nz] = edges.reduce((a, e) => (e[0] < a[0] ? e : a))
  if (d < EDGE_SPAWN) {
    dx += nx * 2
    dz += nz * 2
  }
  return Math.atan2(dz, dx)
}
