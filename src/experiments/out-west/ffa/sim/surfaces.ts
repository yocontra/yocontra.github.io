// biome-ignore-all lint/complexity/useMaxParams: compact pathfinding occupancy queries
/** Static pathfinding occupancy derived from authored layout. Native PlayCanvas owns all movement,
 * support, contact response and shot collision; these helpers only build and prune bot routes. */
import type { ShapedCover } from './cover-shape.ts'
import type { Grid, Rect, Surface } from './layout.ts'

const BODY_HEIGHT = 1.8
const STEP_UP = 0.35
const EPS = 1e-6

function flatCellTop(grid: Grid, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return 12
  }
  return grid.tops[row * grid.n + col] ?? 0
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
