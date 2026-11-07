import { describe, expect, it } from 'bun:test'
import { Box3, Group } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Doors } from '../src/experiments/out-west/ffa/scene/doors.ts'
import { type DressBuilders, dressCover } from '../src/experiments/out-west/ffa/scene/dressing.ts'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { GeoBuilder } from '../src/experiments/out-west/scene/geo.ts'
import { flagsOf } from '../src/experiments/out-west/scene/roles.ts'

async function coverBounds(kind: 'well' | 'covered_wagon') {
  const props = await new GLTFLoader().parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  const cover = TOWN.cover.find((c) => c.kind === kind)
  if (!cover) {
    throw new Error(`Missing ${kind} fixture`)
  }
  const builders: DressBuilders = {
    wood: new GeoBuilder(),
    wall: new GeoBuilder(),
    stone: new GeoBuilder(),
    cloth: new GeoBuilder(),
    extra: [],
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
  const bounds = new Box3()
  const geometries = [builders.wood, builders.wall, builders.stone, builders.cloth]
    .filter((g) => !g.empty)
    .map((g) => g.build())
    .concat(builders.extra)
  for (const geometry of geometries) {
    geometry.computeBoundingBox()
    if (geometry.boundingBox) {
      bounds.union(geometry.boundingBox)
    }
    geometry.dispose()
  }
  return { cover, bounds }
}

describe('cover matches the authoritative world', () => {
  for (const kind of ['well', 'covered_wagon'] as const) {
    it(`${kind} reaches its support height and stays inside its footprint`, async () => {
      const { cover, bounds } = await coverBounds(kind)
      expect(bounds.max.y).toBeCloseTo(cover.top ?? 0, 2)
      expect(bounds.min.x).toBeGreaterThanOrEqual(cover.x - 0.01)
      expect(bounds.max.x).toBeLessThanOrEqual(cover.x + cover.w + 0.01)
      expect(bounds.min.z).toBeGreaterThanOrEqual(cover.z - 0.01)
      expect(bounds.max.z).toBeLessThanOrEqual(cover.z + cover.d + 0.01)
    })
  }

  it('marks swinging cosmetic leaves as nonblocking without disguising them as walls', () => {
    const doors = new Doors([
      {
        x: 60,
        y: 0,
        z: 42.25,
        alongX: true,
        dir: 1,
        length: 0.9,
        height: 2,
        swing: -Math.PI / 2,
        cx: 60,
        cz: 42.25,
      },
    ])
    const scene = new Group()
    doors.attach(scene)
    const flags: ReturnType<typeof flagsOf>[] = []
    scene.traverse((o) => {
      if (o.type === 'Mesh') {
        flags.push(flagsOf(o))
      }
    })
    expect(flags).toEqual([{ nonBlocking: true }])
    doors.dispose()
  })
})
