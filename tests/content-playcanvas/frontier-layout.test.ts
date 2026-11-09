import { describe, expect, test as it } from 'bun:test'
import {
  type Building,
  buildingSideBoxes,
  type WallBox,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'

const building: Building = {
  id: 'opening-regression',
  kind: 'saloon',
  x: 10,
  z: 20,
  w: 12,
  d: 10,
  height: 7.5,
  floors: 2,
  hollow: true,
  doors: [
    { side: 'n', at: 6, width: 2 },
    { side: 'n', at: 3.5, width: 1.5, y0: 3.3 },
  ],
  windows: [0, 1].map((floor) => ({
    id: `stacked-${floor}`,
    side: 'n',
    at: 1.2,
    width: 1.3,
    sill: 0.9 + floor * 3.2,
    top: 2.9 + floor * 3.2,
    floor,
    scale: 1.3,
    shop: false,
  })),
}
const solidAt = (boxes: WallBox[], x: number, y: number, z = 20.25) =>
  boxes.some(
    (box) =>
      x > box.x && x < box.x + box.w && z > box.z && z < box.z + box.d && y > box.y0 && y < box.y1,
  )

describe('Frontier structural openings', () => {
  it('both stacked windows are cut and their spandrel is retained', () => {
    const walls = buildingSideBoxes(building, 'n')
    expect(solidAt(walls, 11.8, 1.8)).toBe(false)
    expect(solidAt(walls, 11.8, 5.1)).toBe(false)
    expect(solidAt(walls, 11.8, 3.5)).toBe(true)
    expect(solidAt(walls, 11.8, 7)).toBe(true)
  })

  it('ground doors retain a real lintel and upper wall', () => {
    const walls = buildingSideBoxes(building, 'n')
    expect(solidAt(walls, 17, 1.7)).toBe(false)
    expect(solidAt(walls, 17, 2.7)).toBe(true)
    expect(solidAt(walls, 17, 5)).toBe(true)
  })

  it('an upstairs exit does not cut a door into the ground floor', () => {
    const walls = buildingSideBoxes(building, 'n')
    expect(solidAt(walls, 14, 1.7)).toBe(true)
    expect(solidAt(walls, 14, 4.5)).toBe(false)
    expect(solidAt(walls, 14, 6.2)).toBe(true)
  })

  it('every structural span stays positive and inside its building side', () => {
    for (const side of ['n', 's', 'e', 'w'] as const) {
      for (const wall of buildingSideBoxes(building, side)) {
        expect(wall.w).toBeGreaterThan(0)
        expect(wall.d).toBeGreaterThan(0)
        expect(wall.y1).toBeGreaterThan(wall.y0)
        expect(wall.x).toBeGreaterThanOrEqual(building.x)
        expect(wall.z).toBeGreaterThanOrEqual(building.z)
        expect(wall.x + wall.w).toBeLessThanOrEqual(building.x + building.w)
        expect(wall.z + wall.d).toBeLessThanOrEqual(building.z + building.d)
      }
    }
  })
})
