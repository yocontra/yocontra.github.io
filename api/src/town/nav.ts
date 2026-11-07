/** Coarse navigation for server bots: a 1 m walkability grid and BFS paths over it. */
import { PLAYER_RADIUS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  circleBlocked,
  type Grid,
} from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { blockedAt } from '../../../src/experiments/out-west/ffa/sim/surfaces.ts'

const NAV_CELL = 1
const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const

export interface NavGrid {
  n: number
  free: Uint8Array
}

interface Point {
  x: number
  z: number
}

/** The small extra test radius covers the continuous leg between its sampled circles. */
function legClear(grid: Grid, from: Point & { y?: number }, to: Point): boolean {
  const distance = Math.hypot(to.x - from.x, to.z - from.z)
  const steps = Math.max(1, Math.ceil(distance / (grid.cell / 8)))
  const radius = PLAYER_RADIUS + distance / steps / 2
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = from.x + (to.x - from.x) * t
    const z = from.z + (to.z - from.z) * t
    if (
      circleBlocked(grid, { x, z, r: radius }, BLOCK_MOVE) ||
      blockedAt(grid, x, z, radius, from.y ?? 0)
    ) {
      return false
    }
  }
  return true
}

/** Near a corner, retain its waypoint until the actual actor can take the following leg. */
export function nextWaypoint(
  grid: Grid,
  path: Point[],
  at: Point & { y?: number; arrivalSquared?: number },
): Point | undefined {
  let next = path[0]
  const arrivalSquared = at.arrivalSquared ?? 0.6
  while (next && (next.x - at.x) ** 2 + (next.z - at.z) ** 2 < arrivalSquared) {
    const after = path[1]
    if (after && !legClear(grid, at, after)) {
      break
    }
    path.shift()
    next = path[0]
  }
  return next
}

export function buildNav(grid: Grid): NavGrid {
  const n = Math.floor(grid.size / NAV_CELL)
  const free = new Uint8Array(n * n)
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = (col + 0.5) * NAV_CELL
      const z = (row + 0.5) * NAV_CELL
      free[row * n + col] =
        circleBlocked(grid, { x, z, r: PLAYER_RADIUS + 0.05 }, BLOCK_MOVE) ||
        blockedAt(grid, x, z, PLAYER_RADIUS + 0.05, 0)
          ? 0
          : 1
    }
  }
  return { n, free }
}

const cellOf = (nav: NavGrid, x: number, z: number): number =>
  Math.max(0, Math.min(nav.n - 1, Math.floor(z / NAV_CELL))) * nav.n +
  Math.max(0, Math.min(nav.n - 1, Math.floor(x / NAV_CELL)))

/** Nearest free cell to (x, z) within a few metres, or −1. */
function nearestFree(nav: NavGrid, x: number, z: number): number {
  const c = cellOf(nav, x, z)
  if (nav.free[c]) {
    return c
  }
  const col = c % nav.n
  const row = Math.floor(c / nav.n)
  for (let r = 1; r <= 3; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const cc = col + dc
        const rr = row + dr
        const j = rr * nav.n + cc
        if (cc >= 0 && rr >= 0 && cc < nav.n && rr < nav.n && nav.free[j]) {
          return j
        }
      }
    }
  }
  return -1
}

function expand(nav: NavGrid, i: number, prev: Int32Array, queue: number[]): void {
  const col = i % nav.n
  const row = Math.floor(i / nav.n)
  for (const [dc, dr] of NEIGHBOURS) {
    const cc = col + dc
    const rr = row + dr
    if (cc < 0 || rr < 0 || cc >= nav.n || rr >= nav.n) {
      continue
    }
    const j = rr * nav.n + cc
    // Diagonals only when both orthogonal cells are free (no corner cutting).
    const cornerOk =
      dc === 0 || dr === 0 || (nav.free[row * nav.n + cc] && nav.free[rr * nav.n + col])
    if (nav.free[j] && prev[j] === -1 && cornerOk) {
      prev[j] = i
      queue.push(j)
    }
  }
}

/** Keep every BFS turn; a fixed stride alone cuts chords through blocked corners. */
function isTurn(cells: readonly number[], index: number, n: number): boolean {
  const before = cells[index - 1]
  const cell = cells[index]
  const after = cells[index + 1]
  if (before === undefined || cell === undefined || after === undefined) {
    return true
  }
  return (
    (cell % n) - (before % n) !== (after % n) - (cell % n) ||
    Math.floor(cell / n) - Math.floor(before / n) !== Math.floor(after / n) - Math.floor(cell / n)
  )
}

/** Cell-centre waypoints, at most three cells apart and preserving every turn. */
export function findPath(
  nav: NavGrid,
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number }[] | null {
  const start = nearestFree(nav, from.x, from.z)
  const goal = nearestFree(nav, to.x, to.z)
  if (start < 0 || goal < 0) {
    return null
  }
  const prev = new Int32Array(nav.n * nav.n).fill(-1)
  prev[start] = start
  const queue = [start]
  for (let head = 0; head < queue.length && prev[goal] === -1; head++) {
    expand(nav, queue[head] ?? start, prev, queue)
  }
  if (prev[goal] === -1) {
    return null
  }
  const cells: number[] = []
  for (let c = goal; c !== start; c = prev[c] ?? start) {
    cells.push(c)
  }
  cells.push(start)
  cells.reverse()
  return cells
    .filter((_, i) => i > 0 && (i % 3 === 0 || isTurn(cells, i, nav.n)))
    .map((c) => ({
      x: ((c % nav.n) + 0.5) * NAV_CELL,
      z: (Math.floor(c / nav.n) + 0.5) * NAV_CELL,
    }))
}
