import { facadeSolids } from '../../src/experiments/out-west/ffa/scene/facade-profile.ts'
import type { Grid, Surface, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { surfaceTop } from '../../src/experiments/out-west/ffa/sim/surfaces.ts'

export type ClothQuery = readonly [number, number, number]

/** Boundary, support, penetration and open-space queries from the actual town surfaces. */
export function clothQueries(grid: Grid, layout: TownLayout): ClothQuery[] {
  const points: ClothQuery[] = []
  const panes: Surface[] = grid.glass.map((pane) => ({
    x: pane.axis === 0 ? pane.at - 0.015 : pane.a0,
    z: pane.axis === 0 ? pane.a0 : pane.at - 0.015,
    w: pane.axis === 0 ? 0.03 : pane.a1 - pane.a0,
    d: pane.axis === 0 ? pane.a1 - pane.a0 : 0.03,
    bottom: pane.y0,
    top: pane.y1,
    kind: 'solid',
  }))
  for (const surface of [
    ...grid.decks,
    ...grid.stairs,
    ...grid.overheads,
    ...grid.roofs,
    ...facadeSolids(layout),
    ...panes,
  ]) {
    surfaceQueries(points, surface)
  }
  for (const shape of grid.shaped) {
    for (const u of [0.01, 0.3, 0.5, 0.7, 0.99]) {
      const x = shape.x + shape.w * u
      const z = shape.z + shape.d * (1 - u)
      for (const dy of [-0.36, -0.25, -0.01, 0, 0.02, 0.36]) {
        points.push([x, shape.heightAt(x, z) + dy, z])
      }
    }
  }
  const size = grid.n * grid.cell
  let state = 0x13_57_9b_df
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_00_00_00_00
  }
  for (let i = 0; i < 4096; i++) {
    points.push([random() * (size + 2) - 1, random() * 19 - 0.55, random() * (size + 2) - 1])
  }
  for (let row = 0; row < grid.n; row += 7) {
    for (let col = 0; col < grid.n; col += 7) {
      const x = col * grid.cell
      const z = row * grid.cell
      const top = grid.tops[row * grid.n + col] ?? 0
      for (const epsilon of [-1e-8, 0, 1e-8]) {
        points.push([x + epsilon, top - 0.01, z + epsilon])
      }
    }
  }
  return points
}

function surfaceQueries(points: ClothQuery[], surface: Surface): void {
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
  ]) {
    const x = surface.x + surface.w * (u ?? 0)
    const z = surface.z + surface.d * (v ?? 0)
    const top = surfaceTop(surface, x, z)
    for (const y of [
      surface.bottom - 0.01,
      surface.bottom,
      surface.bottom + 0.01,
      top - 0.01,
      top,
      top + 0.01,
      top + 0.35,
    ]) {
      for (const epsilon of [-1e-8, 0, 1e-8]) {
        points.push([x + epsilon, y, z + epsilon])
      }
    }
  }
}
