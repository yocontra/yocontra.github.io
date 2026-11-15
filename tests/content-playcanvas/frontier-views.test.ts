import { describe, expect, test as it } from 'bun:test'
import {
  BLOCK_SIGHT,
  buildGrid,
  circleBlocked,
  inRect,
  rayGrid,
  TOWN,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { FRONTIER_VIEWS } from '../../src/experiments/out-west/ffa/town.views.ts'

const grid = buildGrid()
/** Eye-level views; overviews and upper-floor eyes stand above the ground grid. */
const grounded = FRONTIER_VIEWS.filter((view) => view.from[1] < 3)

describe('Frontier QA camera views', () => {
  it('names every view once', () => {
    expect(new Set(FRONTIER_VIEWS.map((view) => view.name)).size).toBe(FRONTIER_VIEWS.length)
  })
  it('keeps street eyes outside every building and room eyes inside theirs', () => {
    for (const view of FRONTIER_VIEWS) {
      const [x, y, z] = view.from
      const within = TOWN.buildings
        .filter((building) => building.height > y && inRect(building, x, z))
        .map((building) => building.id)
      expect({ view: view.name, within }).toEqual({
        view: view.name,
        within: view.inside ? [view.inside] : [],
      })
    }
  })
  it('stands every eye-level camera clear of walls with an open first few metres', () => {
    for (const view of grounded) {
      const [x, , z] = view.from
      const [tx, , tz] = view.to
      const length = Math.hypot(tx - x, tz - z)
      const clear = rayGrid(
        grid,
        { ox: x, oz: z, dx: (tx - x) / length, dz: (tz - z) / length, maxDist: length },
        BLOCK_SIGHT,
      )
      expect({
        view: view.name,
        walled: circleBlocked(grid, { x, z, r: 0.4 }, BLOCK_SIGHT),
        open: clear >= Math.min(4, length),
      }).toEqual({ view: view.name, walled: false, open: true })
    }
  })
})
