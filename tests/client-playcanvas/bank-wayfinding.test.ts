import { expect, test as it } from 'bun:test'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import {
  BankGuide,
  bankWindows,
  flood,
} from '../../src/experiments/out-west/ffa/client/wayfinding.ts'
import { refreshPropGrid } from '../../src/experiments/out-west/ffa/sim/environment-response.ts'
import {
  BLOCK_MOVE,
  BLOCK_SHOT,
  buildGrid,
  rayGrid,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'

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

it('retains exact bank routes across authored movement openings and rebuilds on closure', () => {
  const world = createWorld()
  const intact = world.grid
  const windows = bankWindows()
  const field = flood(intact, windows)
  const guide = Object.assign(Object.create(BankGuide.prototype), {
    grid: intact,
    windows,
    field,
    at: { has: true },
  }) as BankGuide
  const shotOnly = { ...intact, cells: intact.cells.slice() }
  shotOnly.cells[0] = (shotOnly.cells[0] ?? 0) ^ BLOCK_SHOT
  guide.setGrid(shotOnly)
  expect(Reflect.get(guide, 'field')).toBe(field)

  for (let i = 0; i < ENVIRONMENT_PROPS.length; i++) {
    const previous = world.props.slice()
    world.props[i] = 0
    refreshPropGrid(world, previous)
    guide.setGrid(world.grid)
    expect(Reflect.get(guide, 'field')).toBe(field)
    expect(field).toEqual(flood(world.grid, windows))
  }

  guide.setGrid(intact)
  expect(Reflect.get(guide, 'field')).not.toBe(field)
  expect(Reflect.get(guide, 'field')).toEqual(flood(intact, windows))
})
