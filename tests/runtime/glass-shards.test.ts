import { expect, test as it } from 'bun:test'
import { fracture } from '../../src/experiments/out-west/client/glass-shards.ts'

function area(piece: readonly (readonly [number, number])[]): number {
  let sum = 0
  for (const [i, [x0, y0]] of piece.entries()) {
    const [x1, y1] = piece[(i + 1) % piece.length] ?? [x0, y0]
    sum += x0 * y1 - x1 * y0
  }
  return sum / 2
}

it('a shattered pane tiles into convex shards around the bullet hole', () => {
  for (const [seed, strike] of [
    [1, [0.65, 1]],
    [7, [0.05, 0.1]],
    [42, [1.3, 2]],
    [99, [0.3, 1.6]],
  ] as const) {
    const pieces = fracture(1.3, 2.03, strike, seed)
    expect(pieces).toHaveLength(21)
    const areas = pieces.map(area)
    expect(Math.min(...areas)).toBeGreaterThan(0)
    expect(areas.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1.3 * 2.03, 6)
    const turns = pieces.flatMap((piece) =>
      piece.map((point, i) => {
        const b = piece[(i + 1) % piece.length] ?? point
        const c = piece[(i + 2) % piece.length] ?? point
        return (b[0] - point[0]) * (c[1] - b[1]) - (b[1] - point[1]) * (c[0] - b[0])
      }),
    )
    expect(Math.min(...turns)).toBeGreaterThan(-1e-9)
  }
})
