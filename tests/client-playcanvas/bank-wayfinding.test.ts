import { expect, test as it } from 'bun:test'
import {
  BankGuide,
  bankWindows,
  flood,
} from '../../src/experiments/out-west/ffa/client/wayfinding.ts'
import { BLOCK_MOVE, buildGrid, rayGrid } from '../../src/experiments/out-west/ffa/sim/layout.ts'

it('bank waypoints follow walkable paths around authored wall corners', () => {
  const grid = buildGrid()
  const windows = bankWindows()
  const guide = Object.assign(Object.create(BankGuide.prototype), {
    grid,
    windows,
    field: flood(grid, windows),
  }) as BankGuide
  for (const [x, z] of [
    [4.25, 5.75],
    [19.75, 5.75],
    [32.25, 6.75],
    [34.75, 6.75],
  ] as const) {
    const { x: nextX, z: nextZ } = guide.waypoint(x, z, { x, z })
    const dx = nextX - x
    const dz = nextZ - z
    const maxDist = Math.hypot(dx, dz)
    expect(maxDist).toBeGreaterThan(0)
    expect(guide.walk(nextX, nextZ)).toBeLessThan(guide.walk(x, z))
    expect(
      rayGrid(grid, { ox: x, oz: z, dx: dx / maxDist, dz: dz / maxDist, maxDist }, BLOCK_MOVE),
    ).toBe(maxDist)
  }
})
