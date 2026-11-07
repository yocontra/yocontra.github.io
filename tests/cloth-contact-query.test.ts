import { expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { Vector3 } from 'three'
import { corpseGround } from '../src/experiments/out-west/ffa/scene/ragdoll-cloth-contact.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { type ClothQuery, clothQueries } from './helpers/cloth-query-corpus.ts'

/** Golden IEEE-754 outputs from the original provider, before its spatial-index optimization. */
it('preserves all exact town corrections at surfaces, cell boundaries and broken panes', () => {
  const grid = buildGrid(TOWN)
  const queries = clothQueries(grid, TOWN)
  const broken = new Set<number>()
  const ground = corpseGround(grid, TOWN, broken)
  expect(queries.length).toBe(54_043)
  expect(digest(ground, queries)).toEqual([
    0x13_1a_8e_8c, 0x73_55_7c_c5, 0x70_a5_d6_ab, 0x30_f7_31_63, 0xf8_8b_d1_0d, 0x1c_9d_1e_22,
    0x6a_b3_3a_57, 0xeb_de_89_7b,
  ])
  for (const pane of grid.glass) {
    broken.add(pane.index)
  }
  expect(digest(ground, queries)).toEqual([
    0x4b_9a_f4_1a, 0xe1_e6_25_33, 0x8e_71_9c_40, 0x6d_e4_36_77, 0x65_3d_69_23, 0xfc_39_fc_c7,
    0x52_b0_1d_25, 0xb5_b3_c4_32,
  ])
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

function digest(ground: ReturnType<typeof corpseGround>, queries: readonly ClothQuery[]): number[] {
  const hash = createHash('sha256')
  const bytes = Buffer.alloc(32)
  const correction = new Vector3()
  for (const query of queries) {
    const height = ground(...query, correction)
    for (const [i, value] of [height, correction.x, correction.y, correction.z].entries()) {
      bytes.writeDoubleLE(value, i * 8)
    }
    hash.update(bytes)
  }
  const bytes256 = hash.digest()
  return Array.from({ length: 8 }, (_, i) => bytes256.readUInt32BE(i * 4))
}
