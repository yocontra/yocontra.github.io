import { describe, expect, test as it } from 'bun:test'
import {
  type Building,
  buildingSideBoxes,
  type WallBox,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { type CollisionMesh, roofMesh } from '../../tools/content/frontier-collision.ts'

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

function endTriangles(mesh: CollisionMesh, coordinate: 0 | 2, at: number): number {
  let count = 0
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    if (
      mesh.indices
        .slice(offset, offset + 3)
        .every((index) => mesh.positions[index * 3 + coordinate] === at)
    ) {
      count++
    }
  }
  return count
}

it('renders only exposed roof closures and retains both ends in the collider', () => {
  for (const [axis, front, coord, frontAt, backAt] of [
    ['z', 'n', 2, building.z, building.z + building.d],
    ['z', 's', 2, building.z + building.d, building.z],
    ['x', 'w', 0, building.x, building.x + building.w],
    ['x', 'e', 0, building.x + building.w, building.x],
  ] as const) {
    const config = { axis, front, bays: 2, rise: 1.45, overhang: 0.35 }
    const town = { ...building, roof: config }
    const collision = roofMesh(town)
    const visible = roofMesh(town, 'render')
    if (!(collision && visible)) {
      throw new Error('Expected both roof meshes')
    }
    expect(endTriangles(collision, coord, frontAt)).toBeGreaterThan(0)
    expect(endTriangles(visible, coord, frontAt)).toBe(0)
    expect(endTriangles(visible, coord, backAt)).toBe(endTriangles(collision, coord, backAt))
    expect(visible.indices.length).toBe(
      collision.indices.length - 3 * endTriangles(collision, coord, frontAt),
    )
    const tall = { ...town, roof: { ...config, rise: 2 } }
    expect(roofMesh(tall, 'render')).toEqual(roofMesh(tall))
    const solid = { ...town, hollow: false }
    expect(roofMesh(solid, 'render')).toEqual(roofMesh(solid))
  }
})
