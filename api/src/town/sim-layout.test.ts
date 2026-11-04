import { describe, expect, test as it } from 'bun:test'
import {
  PLAYER_RADIUS,
  SPAWN_BANK_CLEARANCE,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  BLOCK_SHOT,
  buildGrid,
  cellAt,
  circleBlocked,
  hasLineOfSight,
  rayGrid,
  TOWN,
  zoneAt,
} from '../../../src/experiments/out-west/ffa/sim/layout.ts'

const grid = buildGrid()

/** Flood-fill walkable cells (with a capsule's clearance) from a start point. */
function reachable(sx: number, sz: number): Uint8Array {
  const seen = new Uint8Array(grid.n * grid.n)
  const free = (col: number, row: number): boolean =>
    !circleBlocked(
      grid,
      { x: (col + 0.5) * grid.cell, z: (row + 0.5) * grid.cell, r: PLAYER_RADIUS * 0.9 },
      BLOCK_MOVE,
    )
  const start = Math.floor(sz / grid.cell) * grid.n + Math.floor(sx / grid.cell)
  const queue = [start]
  seen[start] = 1
  while (queue.length > 0) {
    const i = queue.pop() ?? 0
    const col = i % grid.n
    const row = Math.floor(i / grid.n)
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const c = col + dc
      const r = row + dr
      const j = r * grid.n + c
      if (c >= 0 && r >= 0 && c < grid.n && r < grid.n && !seen[j] && free(c, r)) {
        seen[j] = 1
        queue.push(j)
      }
    }
  }
  return seen
}

const at = (seen: Uint8Array, x: number, z: number): boolean =>
  seen[Math.floor(z / grid.cell) * grid.n + Math.floor(x / grid.cell)] === 1

describe('town layout', () => {
  it('the grid is 288² cells of 0.5 m', () => {
    expect(grid.n).toBe(288)
    expect(grid.cells.length).toBe(288 * 288)
  })

  it('32 spawns: 24 perimeter, 8 interior, none within 30 m of the bank, all clear', () => {
    expect(TOWN.spawns.length).toBe(32)
    expect(TOWN.spawns.filter((s) => s.interior).length).toBe(8)
    const bank = TOWN.buildings.find((b) => b.kind === 'bank')
    expect(bank).toBeDefined()
    const bx = (bank?.x ?? 0) + (bank?.w ?? 0) / 2
    const bz = (bank?.z ?? 0) + (bank?.d ?? 0) / 2
    for (const s of TOWN.spawns) {
      expect(Math.hypot(s.x - bx, s.z - bz)).toBeGreaterThanOrEqual(SPAWN_BANK_CLEARANCE)
      expect(circleBlocked(grid, { x: s.x, z: s.z, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
    }
  })

  it('every spawn, bank window, Stage Line counter, strongbox and pickup spot is reachable from main street', () => {
    const seen = reachable(30, 64)
    for (const s of TOWN.spawns) {
      expect([s.x, s.z, at(seen, s.x, s.z)]).toEqual([s.x, s.z, true])
    }
    for (const z of TOWN.zones) {
      expect([z.id, at(seen, z.x, z.z)]).toEqual([z.id, true])
    }
    for (const s of [...TOWN.strongboxes, ...TOWN.pickups]) {
      expect([s.id, at(seen, s.x, s.z)]).toEqual([s.id, true])
    }
  })

  it('the bank has 4 deposit windows and an entrance on every side', () => {
    expect(TOWN.zones.filter((z) => z.kind === 'bank').length).toBe(4)
    expect(
      new Set(TOWN.buildings.find((b) => b.kind === 'bank')?.doors.map((d) => d.side)).size,
    ).toBe(4)
    expect(zoneAt(TOWN, 64.5, 81.5)?.kind).toBe('bank')
    expect(zoneAt(TOWN, 13, 84)?.kind).toBe('stage')
    expect(zoneAt(TOWN, 30, 64)).toBeNull()
  })

  it('walls block bullets and sight; low cover blocks bullets but not sight', () => {
    // The saloon's west wall at x = 47.
    expect(cellAt(grid, 47.2, 40) & BLOCK_SHOT).toBeTruthy()
    expect(rayGrid(grid, { ox: 45.5, oz: 40, dx: 1, dz: 0, maxDist: 20 }, BLOCK_SHOT)).toBeCloseTo(
      1.5,
      5,
    )
    expect(hasLineOfSight(grid, { x: 45.5, z: 40 }, { x: 60, z: 40 })).toBe(false)
    // A trough on main street: blocks the shot, not the view.
    const trough = TOWN.cover.find((c) => c.kind === 'trough' && c.low)
    expect(trough).toBeDefined()
    const tx = (trough?.x ?? 0) + (trough?.w ?? 0) / 2
    const tz = (trough?.z ?? 0) + (trough?.d ?? 0) / 2
    expect(
      rayGrid(grid, { ox: tx - 5, oz: tz, dx: 1, dz: 0, maxDist: 10 }, BLOCK_SHOT),
    ).toBeLessThan(5)
    expect(hasLineOfSight(grid, { x: tx - 5, z: tz }, { x: tx + 5, z: tz })).toBe(true)
  })

  it('vault heights: low cover only, 0.5 to 1.1 m; tall cover never', () => {
    const vaultable = TOWN.cover.filter((c) => c.vaultHeight !== undefined)
    expect(vaultable.length).toBeGreaterThan(100)
    expect(vaultable.filter((c) => !c.low).map((c) => c.kind)).toEqual([])
    const heights = vaultable.map((c) => c.vaultHeight ?? 0)
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.5)
    expect(Math.max(...heights)).toBeLessThanOrEqual(1.1)
  })

  it('outside the map is solid', () => {
    expect(cellAt(grid, -1, 50)).toBeTruthy()
    expect(cellAt(grid, 50, 200)).toBeTruthy()
  })
})
