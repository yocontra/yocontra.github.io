// biome-ignore-all lint/complexity/useMaxParams: the hot path takes its vectors positionally
/**
 * The 2.5D collision layer: what a rider can stand on, what blocks the capsule, and what is above
 * their head. The grid owns the base solids (walls, crates, wagons); this module adds the thin
 * slabs (porch roofs, catwalks, upper floors), stairs and pitched roofs. Pure and deterministic, so
 * the server and the client's prediction run exactly the same step.
 */

import type { ShapedCover } from './cover-shape.ts'
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

function flatCellTop(grid: Grid, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return 12
  }
  return grid.tops[row * grid.n + col] ?? 0
}

/** Top of flat and shaped base solids at this point, metres (0 = open ground). */
function cellTop(grid: Grid, col: number, row: number, x: number, z: number): number {
  const i = row * grid.n + col
  let top = flatCellTop(grid, col, row)
  const shapes = grid.shapeCells[i]
  if (shapes) {
    for (const shape of shapes) {
      if (inside(shape, x, z)) {
        top = Math.max(top, shape.heightAt(x, z))
      }
    }
  }
  return top
}

function pushOutShapes(grid: Grid, p: Point, radius: number, feetY: number): boolean {
  let moved = false
  for (const shape of grid.shaped) {
    const barrier = shapeBarrier(shape, p.x, p.z, radius, feetY)
    if (barrier && resolveRect(p, barrier, radius)) {
      moved = true
    }
  }
  return moved
}

export function topAt(grid: Grid, x: number, z: number): number {
  return cellTop(grid, Math.floor(x / grid.cell), Math.floor(z / grid.cell), x, z)
}

function shapeBarrier(
  shape: ShapedCover,
  x: number,
  z: number,
  radius: number,
  feetY: number,
): Rect | null {
  if (!circleHitsRect(x, z, radius, shape)) {
    return null
  }
  const center = shape.slopeAt(x, z) ? shape.heightAt(x, z) : 0
  // A rider landing or standing on the continuous roof follows its local slope. A low tongue
  // or an exposed bed never gets this exemption from a distinct taller part of the vehicle.
  if (center > EPS && center <= feetY + STEP_UP + EPS) {
    return null
  }
  return shape.boundsAbove(feetY + STEP_UP)
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
      const top = flatCellTop(grid, col, row)
      if (top > feetY + STEP_UP + EPS && feetY < top - EPS) {
        return true
      }
    }
  }
  for (const shape of grid.shaped) {
    const barrier = shapeBarrier(shape, x, z, r, feetY)
    if (barrier && circleHitsRect(x, z, r, barrier)) {
      return true
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
        const top = flatCellTop(grid, col, row)
        if (
          top > feetY + STEP_UP + EPS &&
          feetY < top - EPS &&
          resolveRect(p, { x: col * c, z: row * c, w: c, d: c }, r)
        ) {
          moved = true
        }
      }
    }
    moved = pushOutShapes(grid, p, r, feetY) || moved
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
  // Ground is a plane, not a one-centimetre sampling band. A 15 cm step can skip that band
  // entirely on a downward shot and carry the ray underground. Keep the exact plane hit as the
  // backstop, still returning any wall or raised slab encountered before it.
  if (oy < -EPS || (oy <= EPS && dy < 0)) {
    return { dist: 0, x: ox, y: oy, z: oz }
  }
  const ground = dy < 0 ? -oy / dy : Number.POSITIVE_INFINITY
  const limit = Math.min(maxDist, ground)
  const step = 0.15
  for (let t = step; t <= limit + EPS; t += step) {
    if (t >= ground - EPS) {
      break
    }
    const x = ox + dx * t
    const y = oy + dy * t
    const z = oz + dz * t
    if (solidAt(grid, x, y, z)) {
      // Refine the last free / first solid interval. Returning the last whole step made decals
      // hover up to 15 cm off a wall and disagreed with the returned point inside that wall.
      let lo = Math.max(0, t - step)
      let hi = t
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        if (solidAt(grid, ox + dx * mid, oy + dy * mid, oz + dz * mid)) {
          hi = mid
        } else {
          lo = mid
        }
      }
      return { dist: hi, x: ox + dx * hi, y: oy + dy * hi, z: oz + dz * hi }
    }
  }
  if (ground >= 0 && ground <= maxDist) {
    return { dist: ground, x: ox + dx * ground, y: 0, z: oz + dz * ground }
  }
  return null
}

/** Outward surface normal at a quantized shot contact, including the slope of pitched roofs. */
export function impactNormal(
  grid: Grid,
  at: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const e = 0.03
  for (const slab of [...grid.overheads, ...grid.stairs, ...grid.roofs]) {
    if (!inside(slab, at.x, at.z)) {
      continue
    }
    const top = surfaceTop(slab, at.x, at.z)
    if (Math.abs(at.y - top) < e) {
      const dx = (surfaceTop(slab, at.x + e, at.z) - surfaceTop(slab, at.x - e, at.z)) / (2 * e)
      const dz = (surfaceTop(slab, at.x, at.z + e) - surfaceTop(slab, at.x, at.z - e)) / (2 * e)
      const length = Math.hypot(dx, 1, dz)
      if (-dx * direction.x + direction.y - dz * direction.z < 0) {
        return { x: -dx / length, y: 1 / length, z: -dz / length }
      }
    }
    if (Math.abs(at.y - slab.bottom) < e && direction.y > 0) {
      return { x: 0, y: -1, z: 0 }
    }
  }
  if (Math.abs(at.y) < e && direction.y < 0) {
    return { x: 0, y: 1, z: 0 }
  }
  const col = Math.floor(at.x / grid.cell)
  const row = Math.floor(at.z / grid.cell)
  for (const shape of grid.shapeCells[row * grid.n + col] ?? []) {
    if (inside(shape, at.x, at.z) && Math.abs(at.y - shape.heightAt(at.x, at.z)) < e) {
      const dx = (shape.heightAt(at.x + e, at.z) - shape.heightAt(at.x - e, at.z)) / (2 * e)
      const dz = (shape.heightAt(at.x, at.z + e) - shape.heightAt(at.x, at.z - e)) / (2 * e)
      const length = Math.hypot(dx, 1, dz)
      if (-dx * direction.x + direction.y - dz * direction.z < 0) {
        return { x: -dx / length, y: 1 / length, z: -dz / length }
      }
    }
  }
  // Walls/cover are axis-aligned cells; sampling across the contact finds their actual face,
  // unlike a decal facing back along an oblique bullet. Tolerance covers centimetre wire rounding.
  const solid = (x: number, y: number, z: number) => Number(solidAt(grid, x, y, z))
  const nx = solid(at.x - e, at.y, at.z) - solid(at.x + e, at.y, at.z)
  const ny = solid(at.x, at.y - e, at.z) - solid(at.x, at.y + e, at.z)
  const nz = solid(at.x, at.y, at.z - e) - solid(at.x, at.y, at.z + e)
  const length = Math.hypot(nx, ny, nz)
  if (length > 0) {
    return { x: nx / length, y: ny / length, z: nz / length }
  }
  const back = Math.hypot(direction.x, direction.y, direction.z) || 1
  return { x: -direction.x / back, y: -direction.y / back, z: -direction.z / back }
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
