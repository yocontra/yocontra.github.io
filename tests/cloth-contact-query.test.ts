import { expect, it } from 'bun:test'
import { Vector3 } from 'three'
import { corpseGround } from '../src/experiments/out-west/ffa/scene/ragdoll-cloth-contact.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { referenceClothGround } from './helpers/cloth-ground-reference.ts'
import { type ClothQuery, clothQueries } from './helpers/cloth-query-corpus.ts'

/** Compare exact IEEE-754 results on the same host; shaped-surface math can vary across hosts. */
it('preserves all exact town corrections at surfaces, cell boundaries and broken panes', () => {
  const grid = buildGrid(TOWN)
  const queries = clothQueries(grid, TOWN)
  const broken = new Set<number>()
  const ground = corpseGround(grid, TOWN, broken)
  const reference = referenceClothGround(grid, TOWN, broken)
  expect(queries.length).toBe(54_043)
  expect(firstDifference(ground, reference, queries)).toBeNull()
  for (const pane of grid.glass) {
    broken.add(pane.index)
  }
  expect(firstDifference(ground, reference, queries)).toBeNull()
})

it('skips irrelevant shaped support math and observes base changes in previously empty cells', () => {
  const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }
  const grid = buildGrid(layout)
  grid.tops.fill(0)
  grid.glass = []
  grid.decks = []
  grid.stairs = []
  grid.roofs = []
  let samples = 0
  grid.overheads = [
    {
      x: 4.05,
      z: 4.05,
      w: 0.1,
      d: 0.1,
      bottom: 1.9,
      top: 2,
      kind: 'overhead',
      heightAt: () => {
        samples++
        return 2
      },
    },
  ]
  const ground = corpseGround(grid, layout)
  const correction = new Vector3(1, 2, 3)
  expect(ground(4.45, 2.1, 4.45, correction)).toBe(0)
  expect(samples).toBe(0)
  expect(correction.lengthSq()).toBe(0)
  expect(ground(4.1, 2.1, 4.1, correction)).toBe(2)
  expect(samples).toBeGreaterThan(0)
  grid.tops[Math.floor(4.45 / grid.cell) * grid.n + Math.floor(4.45 / grid.cell)] = 2
  expect(ground(4.45, 2.1, 4.45, correction)).toBe(2)
})

it('retains support outside the base grid and resets correction on invalid inputs', () => {
  const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }
  const grid = buildGrid(layout)
  grid.tops.fill(0)
  grid.glass = []
  grid.decks = []
  grid.stairs = []
  grid.roofs = []
  grid.overheads = [{ x: -1.2, z: -1.2, w: 0.4, d: 0.4, bottom: 0.9, top: 1, kind: 'overhead' }]
  const ground = corpseGround(grid, layout)
  const correction = new Vector3()
  expect(ground(-1.1, 1.1, -1.1, correction)).toBe(1)
  expect(correction.lengthSq()).toBe(0)
  correction.set(1, 2, 3)
  expect(ground(Number.NaN, 0, 0, correction)).toBe(0)
  expect(correction.lengthSq()).toBe(0)
})

it('detects omitted support candidates and even a single changed correction component', () => {
  const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }
  const grid = buildGrid(layout)
  grid.tops.fill(0)
  grid.overheads = [{ x: 4, z: 4, w: 1, d: 1, bottom: 1.9, top: 2, kind: 'overhead' }]
  const reference = referenceClothGround(grid, layout)
  const omitted = corpseGround({ ...grid, overheads: [] }, layout)
  expect(firstDifference(omitted, reference, [[4.5, 2.1, 4.5]])).not.toBeNull()
  const ground = corpseGround(grid, layout)
  const changed: ReturnType<typeof corpseGround> = (x, y, z, correction) => {
    const height = ground(x, y, z, correction)
    if (correction) {
      correction.x += Number.EPSILON
    }
    return height
  }
  expect(firstDifference(changed, reference, [[4.5, 2.1, 4.5]])).not.toBeNull()
})

function firstDifference(
  ground: ReturnType<typeof corpseGround>,
  reference: ReturnType<typeof corpseGround>,
  queries: readonly ClothQuery[],
) {
  const correction = new Vector3()
  const original = new Vector3()
  for (const [index, query] of queries.entries()) {
    const actual = [ground(...query, correction), correction.x, correction.y, correction.z]
    const expected = [reference(...query, original), original.x, original.y, original.z]
    actual.push(ground(...query))
    expected.push(reference(...query))
    if (actual.some((value, component) => !Object.is(value, expected[component]))) {
      return { index, query, actual, expected }
    }
  }
  return null
}
