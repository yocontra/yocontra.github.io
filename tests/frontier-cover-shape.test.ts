import { describe, expect, it } from 'bun:test'
import { DoubleSide, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { place, run, testWorld } from '../api/src/town/test-helpers.ts'
import { dressCover } from '../src/experiments/out-west/ffa/scene/dressing.ts'
import { buildGrid, type Cover, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import {
  blockedAt,
  impactNormal,
  pushOutVertical,
  rayWorld,
  solidAt,
  supportTop,
  topAt,
} from '../src/experiments/out-west/ffa/sim/surfaces.ts'
import { GeoBuilder } from '../src/experiments/out-west/scene/geo.ts'

async function drawnCover(cover: Cover) {
  const props = await new GLTFLoader().parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  const builders = {
    wood: new GeoBuilder(),
    wall: new GeoBuilder(),
    stone: new GeoBuilder(),
    cloth: new GeoBuilder(),
    extra: [] as import('three').BufferGeometry[],
  }
  dressCover({
    layout: { ...TOWN, buildings: [], cover: [cover] },
    props,
    structure: builders,
    interior: () => builders,
    floorAt: () => 0,
    porchRoof: 3,
    kit: () => undefined,
    outskirts: () => undefined,
  })
  const root = new Group()
  const material = new MeshBasicMaterial({ side: DoubleSide })
  for (const b of [builders.wood, builders.wall, builders.stone, builders.cloth]) {
    if (!b.empty) {
      root.add(new Mesh(b.build(), material))
    }
  }
  for (const g of builders.extra) {
    root.add(new Mesh(g, material))
  }
  root.updateMatrixWorld(true)
  const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0))
  return {
    top: (x: number, z: number) => {
      ray.ray.origin.set(x, 10, z)
      return ray.intersectObject(root, true)[0]?.point.y ?? 0
    },
    dispose: () => {
      root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose()
        }
      })
      material.dispose()
    },
  }
}

describe('shaped cover contact', () => {
  for (const cover of [
    TOWN.cover.find((c) => c.kind === 'well'),
    TOWN.cover.find((c) => c.kind === 'covered_wagon' && c.w > c.d),
    TOWN.cover.find((c) => c.kind === 'covered_wagon' && c.d > c.w),
  ]) {
    if (!cover) {
      throw new Error('Missing cover fixture')
    }
    it(`matches actual off-center ${cover.kind} geometry (${cover.w}x${cover.d}) for feet and rays`, async () => {
      const drawn = await drawnCover(cover)
      const grid = buildGrid({ ...TOWN, buildings: [], cover: [cover] })
      try {
        for (const u of [0.08, 0.23, 0.5, 0.76, 0.94]) {
          for (const b of [-0.64, -0.4, 0, 0.25, 0.62]) {
            const alongX = cover.w >= cover.d
            const a =
              cover.kind === 'well'
                ? (u - 0.5) * 1.4
                : 0.45 + (u - 0.5) * (Math.max(cover.w, cover.d) - 1.35)
            const x = cover.x + cover.w / 2 + (alongX ? a : b)
            const z = cover.z + cover.d / 2 + (alongX ? b : a)
            const top = topAt(grid, x, z)
            expect(Math.abs(top - drawn.top(x, z))).toBeLessThan(0.015)
            expect(supportTop(grid, x, z, 10)).toBe(top)
            expect(solidAt(grid, x, top - 0.01, z)).toBe(true)
            expect(solidAt(grid, x, top + 0.02, z)).toBe(false)
            const hit = rayWorld(grid, x, 6, z, 0, -1, 0, 8)
            expect(hit?.y).toBeCloseTo(top, 2)
            expect(hit?.dist).toBeCloseTo(6 - top, 2)
          }
        }
      } finally {
        drawn.dispose()
      }
    })
  }

  it('lets a ray pass above the exposed wagon end and uses the roof slope for impact normals', () => {
    const cover = TOWN.cover.find((c) => c.kind === 'covered_wagon') as Cover
    const grid = buildGrid({ ...TOWN, buildings: [], cover: [cover] })
    const x = cover.x + 0.4
    const z = cover.z + cover.d / 2
    expect(topAt(grid, x, z)).toBeLessThan(1)
    expect(rayWorld(grid, x, 2, z - 0.7, 0, 0, 1, 1.4)).toBeNull()
    const well = TOWN.cover.find((c) => c.kind === 'well') as Cover
    const wg = buildGrid({ ...TOWN, buildings: [], cover: [well] })
    const at = { x: well.x + 1, z: well.z + 1.5, y: 0 }
    at.y = topAt(wg, at.x, at.z)
    const normal = impactNormal(wg, at, { x: 0, y: -1, z: 0 })
    expect(normal.y).toBeCloseTo(1 / Math.hypot(1, 0.4 / 0.9), 5)
    expect(normal.z).toBeGreaterThan(0)
  })

  it('lands and stays on an off-center well roof instead of its old invisible flat cap', () => {
    const world = testWorld()
    const well = TOWN.cover.find((c) => c.kind === 'well') as Cover
    const rider = place(world, well.x + 1, well.z + 1.5)
    rider.y = 5
    rider.grounded = false
    rider.vy = 0
    rider.airPeakY = 5
    run(world, 40)
    expect(rider.grounded).toBe(true)
    expect(rider.y).toBeCloseTo(WELL_TOP, 2)
    expect(rider.y).toBeLessThan(2.5)
    run(world, 10)
    expect(rider.y).toBeCloseTo(WELL_TOP, 2)
  })

  it('lands on either wagon orientation and follows its canvas when walking along it', () => {
    for (const alongX of [true, false]) {
      const world = testWorld()
      const cover = TOWN.cover.find(
        (c) => c.kind === 'covered_wagon' && c.w >= c.d === alongX,
      ) as Cover
      const x = cover.x + cover.w / 2 + (alongX ? 0.45 : 0.4)
      const z = cover.z + cover.d / 2 + (alongX ? 0.4 : 0.45)
      const rider = place(world, x, z)
      rider.y = 5
      rider.grounded = false
      rider.vy = 0
      rider.airPeakY = 5
      const grid = buildGrid()
      run(world, 40)
      expect(rider.grounded).toBe(true)
      expect(rider.y).toBeCloseTo(topAt(grid, rider.x, rider.z), 2)
      expect(rider.y).toBeLessThan(2.95)
      run(world, 3, { [rider.id]: () => (alongX ? { moveX: 127 } : { moveZ: 127 }) })
      expect(rider.grounded).toBe(true)
      expect(rider.y).toBeCloseTo(topAt(grid, rider.x, rider.z), 2)
    }
  })

  it('does not evaluate cover profiles on unrelated grid cells', () => {
    const grid = buildGrid()
    const shape = grid.shapeCells.find((cell) => cell)?.[0]
    if (!shape) {
      throw new Error('Missing shape bucket')
    }
    const original = shape.heightAt
    let calls = 0
    shape.heightAt = (x, z) => {
      calls++
      return original(x, z)
    }
    for (let i = 0; i < 10_000; i++) {
      topAt(grid, 20, 64)
    }
    expect(calls).toBe(0)
    topAt(grid, shape.x + shape.w / 2, shape.z + shape.d / 2)
    expect(calls).toBe(1)
  })

  it('keeps a capsule outside visible well stone even when its centre misses the inset profile', () => {
    const well = TOWN.cover.find((c) => c.kind === 'well') as Cover
    const grid = buildGrid({ ...TOWN, buildings: [], cover: [well] })
    const x = well.x - 0.2
    const z = well.z + 0.5
    expect(topAt(grid, x, z)).toBe(0)
    expect(blockedAt(grid, x, z, 0.4, 0)).toBe(true)
    const resolved = pushOutVertical(grid, { x, z, r: 0.4 }, 0)
    expect(resolved.x).toBeLessThanOrEqual(well.x + 0.031 - 0.4)
    expect(blockedAt(grid, resolved.x, resolved.z, 0.4, 0)).toBe(false)
  })

  it('does not use the low wagon tongue to exempt the capsule from a taller bed and canvas', () => {
    const cover = TOWN.cover.find((c) => c.kind === 'covered_wagon') as Cover
    const grid = buildGrid({ ...TOWN, buildings: [], cover: [cover] })
    const x = cover.x + 0.75
    const z = cover.z + cover.d / 2
    expect(topAt(grid, x, z)).toBeCloseTo(0.45, 5)
    expect(blockedAt(grid, x, z, 0.4, 0.45)).toBe(true)
    expect(pushOutVertical(grid, { x, z, r: 0.4 }, 0.45).x).toBeLessThan(x)
  })
})

const WELL_TOP = 2.17 + 0.4 * (1 - 0.5 / 0.9)
