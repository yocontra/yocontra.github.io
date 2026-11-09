import { describe, expect, test as it } from 'bun:test'
import {
  PICKUP_RADIUS,
  PLAYER_RADIUS,
  STRONGBOX_RADIUS,
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

import { COMBAT_LANE, serviceZone } from './testing/map-fixtures.ts'

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
  it('the authored 104 m grid is 208² cells of 0.5 m', () => {
    expect(grid.n).toBe(TOWN.size / 0.5)
    expect(grid.cell).toBe(0.5)
    expect(grid.cells.length).toBe(208 * 208)
  })

  it('48 screened spawns span perimeter and interior, all capsule-clear', () => {
    expect(TOWN.spawns).toHaveLength(48)
    expect(TOWN.spawns.some((spawn) => spawn.interior)).toBe(true)
    expect(TOWN.spawns.some((spawn) => !spawn.interior)).toBe(true)
    expect(new Set(TOWN.spawns.map((spawn) => `${spawn.x},${spawn.z}`)).size).toBe(48)
    for (const spawn of TOWN.spawns) {
      expect(spawn.x).toBeGreaterThan(PLAYER_RADIUS)
      expect(spawn.z).toBeGreaterThan(PLAYER_RADIUS)
      expect(spawn.x).toBeLessThan(TOWN.size - PLAYER_RADIUS)
      expect(spawn.z).toBeLessThan(TOWN.size - PLAYER_RADIUS)
      expect(circleBlocked(grid, { ...spawn, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
    }
  })

  it('every spawn, service and loot approach connects to main street in the ground grid', () => {
    const seen = reachable(COMBAT_LANE.from.x, COMBAT_LANE.from.z)
    for (const s of TOWN.spawns) {
      expect([s.x, s.z, at(seen, s.x, s.z)]).toEqual([s.x, s.z, true])
    }
    for (const z of TOWN.zones) {
      expect([z.id, at(seen, z.x, z.z)]).toEqual([z.id, true])
    }
    for (const [spots, radius] of [
      [TOWN.strongboxes, STRONGBOX_RADIUS],
      [TOWN.pickups, PICKUP_RADIUS],
    ] as const) {
      for (const spot of spots) {
        // Loot can sit on hay or a balcony: its centre need not be a ground cell.
        // Native traversal/height tests cover the supporting three-dimensional surface.
        let approach = false
        const x0 = (Math.floor((spot.x - radius) / grid.cell) + 0.5) * grid.cell
        const z0 = (Math.floor((spot.z - radius) / grid.cell) + 0.5) * grid.cell
        for (let z = z0; z <= spot.z + radius; z += grid.cell) {
          for (let x = x0; x <= spot.x + radius; x += grid.cell) {
            approach ||= Math.hypot(x - spot.x, z - spot.z) <= radius && at(seen, x, z)
          }
        }
        expect([spot.id, approach]).toEqual([spot.id, true])
      }
    }
  })

  it('the bank has 4 deposit windows and an entrance on every side', () => {
    expect(TOWN.zones.filter((z) => z.kind === 'bank').length).toBe(4)
    expect(
      new Set(TOWN.buildings.find((b) => b.kind === 'bank')?.doors.map((d) => d.side)).size,
    ).toBe(4)
    for (const kind of ['bank', 'stage'] as const) {
      const zone = serviceZone(kind)
      expect(zoneAt(TOWN, zone.x, zone.z, zone.y)?.kind).toBe(kind)
      expect(zoneAt(TOWN, zone.x, zone.z, (zone.y ?? 0) + 3.3)).toBeNull()
    }
    expect(zoneAt(TOWN, COMBAT_LANE.from.x, COMBAT_LANE.from.z)).toBeNull()
  })

  it('walls block bullets and sight; low cover blocks bullets but not sight', () => {
    const saloon = TOWN.buildings.find((building) => building.kind === 'saloon')
    if (!saloon) {
      throw new Error('Missing saloon')
    }
    const wz = saloon.z + 6
    expect(cellAt(grid, saloon.x + 0.2, wz) & BLOCK_SHOT).toBeTruthy()
    expect(
      rayGrid(grid, { ox: saloon.x - 1.5, oz: wz, dx: 1, dz: 0, maxDist: 5 }, BLOCK_SHOT),
    ).toBeCloseTo(1.5, 5)
    expect(hasLineOfSight(grid, { x: saloon.x - 1.5, z: wz }, { x: saloon.x + 2, z: wz })).toBe(
      false,
    )
    const bench = TOWN.cover.find((cover) => cover.kind === 'workbench' && cover.low && !cover.y0)
    if (!bench) {
      throw new Error('Missing low workbench')
    }
    const z = bench.z + bench.d / 2
    const from = { x: bench.x - 0.5, z }
    const to = { x: bench.x + bench.w + 0.5, z }
    expect(
      rayGrid(grid, { ox: from.x, oz: z, dx: 1, dz: 0, maxDist: bench.w + 1 }, BLOCK_SHOT),
    ).toBeCloseTo(0.5, 5)
    expect(hasLineOfSight(grid, from, to)).toBe(true)
  })

  it('vault heights stay within the native 1.2 m low traversal limit; tall cover never', () => {
    const vaultable = TOWN.cover.filter((c) => c.vaultHeight !== undefined)
    expect(vaultable.length).toBeGreaterThan(100)
    expect(vaultable.filter((c) => !c.low).map((c) => c.kind)).toEqual([])
    const heights = vaultable.map((c) => c.vaultHeight ?? 0)
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.5)
    expect(Math.max(...heights)).toBeLessThanOrEqual(1.2)
  })

  it('outside the map is solid', () => {
    expect(cellAt(grid, -1, 50)).toBeTruthy()
    expect(cellAt(grid, 50, 200)).toBeTruthy()
  })
})
