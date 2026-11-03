/**
 * The clock tower's masonry atlas (`tex/civic_*.webp`, built by `tools/build-civic-atlas.ts`):
 * four Poly Haven sets in a 2x2 grid, each a single tile inside a wrapped gutter. Geometry picks
 * a cell by offsetting U by `cell * CIVIC_CELL_U` (scene/civic.ts decodes it in the shader).
 */

/** Gutter on each side of a cell, as a fraction of the cell. */
export const CIVIC_GUTTER = 1 / 32

/** U offset that selects a cell (U stays well inside ±CIVIC_CELL_U / 2 on the tower). */
export const CIVIC_CELL_U = 1000

export type CivicCell = 'brick' | 'stone' | 'slate' | 'tin'

/** Cell order is the atlas order (column = i % 2, row from the top = floor(i / 2)). */
export const CIVIC_SETS: readonly { cell: CivicCell; id: string; metres: number }[] = [
  { cell: 'brick', id: 'red_brick', metres: 1.4 },
  { cell: 'stone', id: 'sandstone_blocks_08', metres: 3 },
  { cell: 'slate', id: 'roof_slates_02', metres: 3 },
  { cell: 'tin', id: 'rusty_metal_sheet', metres: 2 },
]

export const CIVIC_INDEX: Record<CivicCell, number> = {
  brick: 0,
  stone: 1,
  slate: 2,
  tin: 3,
}
