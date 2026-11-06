// biome-ignore-all lint/complexity/useMaxParams: the hot path takes its vectors positionally
/**
 * The 2.5D collision layer: what a rider can stand on, what blocks the capsule, and what is above
 * their head. The grid owns the base solids (walls, crates, wagons); this module adds the thin
 * slabs (porch roofs, catwalks, upper floors), stairs and pitched roofs. Pure and deterministic, so
 * the server and the client's prediction run exactly the same step.
 */
import { cellAt, type Grid, type Point, type Rect, type Surface } from './layout.ts'

/** A standing rider's capsule, metres. */
export const BODY_HEIGHT = 1.8
export const CROUCH_HEIGHT = 1.2
export const PLAYER_RADIUS = 0.4
/** The tallest ledge a rider walks up without jumping. */
export const STEP_UP = 0.35
/** The deepest drop that keeps the feet glued to the surface. */
export const STEP_DOWN = 0.45
/** The steepest roof a rider can walk up (rise/run). */
export const MAX_WALK_SLOPE = 0.8
const EPS = 1e-6

export interface Support {
  top: number
  surface: Surface | null
}

const inside = (r: Rect, x: number, z: number): boolean =>
  x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d

/** Top of the base solid at (x, z), metres (0 = open ground). */
export function topAt(grid: Grid, x: number, z: number): number {
  const col = Math.floor(x / grid.cell)
  const row = Math.floor(z / grid.cell)
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return 12
  }
  return grid.tops[row * grid.n + col] ?? 0
}

/** The top of a surface at (x, z), following roofs and stairs. */
export function surfaceTop(s: Surface, x: number, z: number): number {
  return s.heightAt ? s.heightAt(x, z) : s.top
}

/** Whether a circle at (x, z) overlaps a rect. */
export function circleHitsRect(x: number, z: number, r: number, rect: Rect): boolean {
  const nx = Math.max(rect.x, Math.min(x, rect.x + rect.w))
  const nz = Math.max(rect.z, Math.min(z, rect.z + rect.d))
  return (x - nx) ** 2 + (z - nz) ** 2 < r * r
}

/**
 * The highest surface the feet can rest on, without allocating a support record. The movement
 * hot path calls this several times per tick; `supportAt` is only for the mantle probe.
 */
export function supportTop(grid: Grid, x: number, z: number, feetY: number): number {
  let top = 0
  const base = topAt(grid, x, z)
  if (base <= feetY + STEP_UP + EPS) {
    top = base
  }
  const consider = (s: Surface): void => {
    if (!inside(s, x, z)) {
      return
    }
    const t = surfaceTop(s, x, z)
    if (t <= feetY + STEP_UP + EPS && t > top) {
      top = t
    }
  }
  for (const s of grid.decks) {
    consider(s)
  }
  for (const s of grid.stairs) {
    consider(s)
  }
  for (const s of grid.overheads) {
    consider(s)
  }
  for (const s of grid.roofs) {
    consider(s)
  }
  return top
}

/** The highest surface the feet can rest on at (x, z), at or below `feetY + STEP_UP`. */
export function supportAt(grid: Grid, x: number, z: number, feetY: number): Support {
  let top = 0
  let surface: Surface | null = null
  const base = topAt(grid, x, z)
  if (base <= feetY + STEP_UP + EPS) {
    top = base
  }
  const consider = (s: Surface): void => {
    if (!inside(s, x, z)) {
      return
    }
    const t = surfaceTop(s, x, z)
    if (t <= feetY + STEP_UP + EPS && t > top) {
      top = t
      surface = s
    }
  }
  for (const s of grid.decks) {
    consider(s)
  }
  for (const s of grid.stairs) {
    consider(s)
  }
  for (const s of grid.overheads) {
    consider(s)
  }
  for (const s of grid.roofs) {
    consider(s)
  }
  return { top, surface }
}

/** Whether the support found at (x, z) is a real standing surface (not a fence rail). */
export function standableSupport(grid: Grid, x: number, z: number, sup: Support): boolean {
  if (sup.surface) {
    return sup.surface.kind !== 'rail'
  }
  const col = Math.floor(x / grid.cell)
  const row = Math.floor(z / grid.cell)
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return false
  }
  return grid.standable[row * grid.n + col] === 1
}

/** The lowest surface above the feet that limits headroom, or Infinity. */
export function ceilingAt(grid: Grid, x: number, z: number, feetY: number): number {
  let bottom = Number.POSITIVE_INFINITY
  const consider = (s: Surface): void => {
    if (!inside(s, x, z)) {
      return
    }
    const b = s.bottom
    if (b > feetY + 0.05 && b < bottom) {
      bottom = b
    }
  }
  for (const s of grid.overheads) {
    consider(s)
  }
  for (const s of grid.stairs) {
    consider(s)
  }
  for (const s of grid.roofs) {
    consider(s)
  }
  return bottom
}

/** Whether the capsule at (x, z, feetY) overlaps a solid. */
export function blockedAt(
  grid: Grid,
  x: number,
  z: number,
  r: number,
  feetY: number,
  height = BODY_HEIGHT,
): boolean {
  const head = feetY + height
  const c = grid.cell
  const c0 = Math.floor((x - r) / c)
  const c1 = Math.floor((x + r) / c)
  const r0 = Math.floor((z - r) / c)
  const r1 = Math.floor((z + r) / c)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const nx = Math.max(col * c, Math.min(x, (col + 1) * c))
      const nz = Math.max(row * c, Math.min(z, (row + 1) * c))
      if ((x - nx) ** 2 + (z - nz) ** 2 >= r * r) {
        continue
      }
      const top = topAt(grid, (col + 0.5) * c, (row + 0.5) * c)
      if (top > feetY + STEP_UP + EPS && feetY < top - EPS) {
        return true
      }
    }
  }
  const slab = (s: Surface): boolean => {
    if (!circleHitsRect(x, z, r, s)) {
      return false
    }
    const top = surfaceTop(s, x, z)
    return s.bottom < head - EPS && top > feetY + STEP_UP + EPS
  }
  for (const s of grid.stairs) {
    if (slab(s)) {
      return true
    }
  }
  for (const s of grid.overheads) {
    if (slab(s)) {
      return true
    }
  }
  for (const s of grid.roofs) {
    if (slab(s)) {
      return true
    }
  }
  return false
}

/** Push a circle out of one rect. Returns true if it moved. */
function resolveRect(p: Point, rect: Rect, r: number): boolean {
  const nx = Math.max(rect.x, Math.min(p.x, rect.x + rect.w))
  const nz = Math.max(rect.z, Math.min(p.z, rect.z + rect.d))
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
  const left = p.x - rect.x
  const right = rect.x + rect.w - p.x
  const up = p.z - rect.z
  const down = rect.z + rect.d - p.z
  const m = Math.min(left, right, up, down)
  if (m === left) {
    p.x = rect.x - r
  } else if (m === right) {
    p.x = rect.x + rect.w + r
  } else if (m === up) {
    p.z = rect.z - r
  } else {
    p.z = rect.z + rect.d + r
  }
  return true
}

/** Push a circle out of every solid it overlaps at this height. Deterministic, three passes. */
export function pushOutVertical(
  grid: Grid,
  { x, z, r }: { x: number; z: number; r: number },
  feetY: number,
  height = BODY_HEIGHT,
  except = 0,
): Point {
  const p = { x, z }
  const c = grid.cell
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    const c0 = Math.floor((p.x - r) / c)
    const c1 = Math.floor((p.x + r) / c)
    const r0 = Math.floor((p.z - r) / c)
    const r1 = Math.floor((p.z + r) / c)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cx = (col + 0.5) * c
        const cz = (row + 0.5) * c
        if (except !== 0 && (cellAt(grid, cx, cz) & except) !== 0) {
          continue
        }
        const top = topAt(grid, cx, cz)
        if (
          top > feetY + STEP_UP + EPS &&
          feetY < top - EPS &&
          resolveRect(p, { x: col * c, z: row * c, w: c, d: c }, r)
        ) {
          moved = true
        }
      }
    }
    const slab = (s: Surface): void => {
      if (!circleHitsRect(p.x, p.z, r, s)) {
        return
      }
      const top = surfaceTop(s, p.x, p.z)
      if (s.bottom < feetY + height - EPS && top > feetY + STEP_UP + EPS && resolveRect(p, s, r)) {
        moved = true
      }
    }
    for (const s of grid.stairs) {
      slab(s)
    }
    for (const s of grid.overheads) {
      slab(s)
    }
    for (const s of grid.roofs) {
      slab(s)
    }
    if (!moved) {
      break
    }
  }
  return p
}

/** Whether (x, y, z) lies inside one raised surface (deck, stair, overhead, roof). */
function insideSurface(s: Surface, x: number, y: number, z: number): boolean {
  if (!inside(s, x, z)) {
    return false
  }
  const top = surfaceTop(s, x, z)
  return y >= s.bottom - EPS && y <= top + EPS
}

/** Whether a point in space is inside a solid (for a 3D shot). */
export function solidAt(grid: Grid, x: number, y: number, z: number): boolean {
  const top = topAt(grid, x, z)
  if (y >= -0.01 && y <= top + EPS) {
    return !insideWindowHole(grid, x, y, z)
  }
  for (const s of grid.stairs) {
    if (insideSurface(s, x, y, z)) {
      return true
    }
  }
  for (const s of grid.overheads) {
    if (insideSurface(s, x, y, z)) {
      return true
    }
  }
  for (const s of grid.roofs) {
    if (insideSurface(s, x, y, z)) {
      return true
    }
  }
  return false
}

/** Whether (x, y, z) is inside a cut window opening, so a 3D ray passes through the wall. */
function insideWindowHole(grid: Grid, x: number, y: number, z: number): boolean {
  const col = Math.floor(x / grid.cell)
  const row = Math.floor(z / grid.cell)
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return false
  }
  const i = row * grid.n + col
  const from = grid.holeStarts[i] ?? 0
  const to = grid.holeStarts[i + 1] ?? 0
  for (let k = from; k < to; k++) {
    const h = grid.windowHoles[grid.holeRefs[k] ?? -1]
    if (
      h &&
      x >= h.x - EPS &&
      x <= h.x + h.w + EPS &&
      z >= h.z - EPS &&
      z <= h.z + h.d + EPS &&
      y >= h.y0 - EPS &&
      y <= h.y1 + EPS
    ) {
      return true
    }
  }
  return false
}

export interface RayHit {
  dist: number
  x: number
  y: number
  z: number
}

/**
 * Walk a 3D ray through the world in 15 cm steps. Good enough for 22–35 m hitscan, deterministic,
 * and it sees walls, crates, porch roofs, floors and pitched roofs.
 */
export function rayWorld(
  grid: Grid,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): RayHit | null {
  const step = 0.15
  for (let t = step; t <= maxDist + EPS; t += step) {
    const x = ox + dx * t
    const y = oy + dy * t
    const z = oz + dz * t
    if (solidAt(grid, x, y, z)) {
      return { dist: Math.max(0, t - step), x, y, z }
    }
  }
  return null
}

/** Line of sight between two 3D points. */
export function hasLineOfSight3D(
  grid: Grid,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const d = Math.hypot(dx, dy, dz)
  if (d < EPS) {
    return true
  }
  const hit = rayWorld(grid, a.x, a.y, a.z, dx / d, dy / d, dz / d, d)
  return !hit || hit.dist >= d - 0.05
}

/**
 * Whether a roof cell is walkable at this point. The roof is a surface, not a wall: a rider can
 * stand anywhere on it, but cannot walk up a slope steeper than `MAX_WALK_SLOPE`.
 */
export function roofWalkable(
  s: Surface,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): boolean {
  if (s.kind !== 'roof' || !s.heightAt) {
    return true
  }
  const rise = Math.abs(s.heightAt(toX, toZ) - s.heightAt(fromX, fromZ))
  const run = Math.hypot(toX - fromX, toZ - fromZ)
  return run < EPS || rise / run <= MAX_WALK_SLOPE
}
