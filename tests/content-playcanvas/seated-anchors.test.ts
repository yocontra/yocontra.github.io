import { expect, test as it } from 'bun:test'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dequantizePrimitive } from '@gltf-transform/functions'
import { Mat4, Vec3 } from 'playcanvas'
import bank from '../../src/experiments/out-west/content/bank.json' with { type: 'json' }
import depot from '../../src/experiments/out-west/content/depot.json' with { type: 'json' }
import mission from '../../src/experiments/out-west/content/mission.json' with { type: 'json' }
import street from '../../src/experiments/out-west/content/street-life.json' with { type: 'json' }
import { campaignSeats } from '../../src/experiments/out-west/duel/native-arenas.ts'

type Triangle = [Vec3, Vec3, Vec3]
const cross = (a: Vec3, b: Vec3, c: Vec3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
function flatTriangles(primitive: Primitive, matrix: Mat4): Triangle[] {
  dequantizePrimitive(primitive)
  const position = primitive.getAttribute('POSITION')
  const indices = primitive.getIndices()
  if (!(position && indices)) {
    return []
  }
  const triangles: Triangle[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const [a, b, c] = [0, 1, 2].map((corner) => {
      const [x = 0, y = 0, z = 0] = position.getElement(indices.getScalar(i + corner), [])
      return matrix.transformPoint(new Vec3(x, y, z))
    })
    if (!(a && b && c)) {
      throw new Error('Native source has an incomplete triangle')
    }
    if (
      Math.max(a.y, b.y, c.y) - Math.min(a.y, b.y, c.y) < 0.002 &&
      Math.abs(cross(a, b, c)) > 1e-8
    ) {
      triangles.push([a, b, c])
    }
  }
  return triangles
}
function horizontalSurfaces(doc: Document): Triangle[] {
  return doc
    .getRoot()
    .listNodes()
    .flatMap(
      (node) =>
        node
          .getMesh()
          ?.listPrimitives()
          .flatMap((primitive) =>
            flatTriangles(primitive, new Mat4().set(node.getWorldMatrix())),
          ) ?? [],
    )
}
function heightsAt(triangles: Triangle[], x: number, z: number): number[] {
  const point = new Vec3(x, 0, z)
  return triangles.flatMap(([a, b, c]) => {
    const signs = [cross(a, b, point), cross(b, c, point), cross(c, a, point)]
    return signs.every((v) => v >= -1e-5) || signs.every((v) => v <= 1e-5) ? [a.y] : []
  })
}

it('all twelve campaign seated anchors match actual native bench wood and floor surfaces', async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  // Non-street encounters retain the shared native street ground at Y=0.
  const shared = horizontalSurfaces(
    await io.read('public/experiments/out-west/3d/native-v2/baked/duel.glb'),
  )
  let count = 0
  for (const [id, source] of [
    ['duel', street],
    ['depot', depot.life],
    ['mission', mission.life],
    ['bank', bank.life],
  ] as const) {
    const life = campaignSeats(source)
    const doc = await io.read(`public/experiments/out-west/3d/native-v2/baked/${id}.glb`)
    const surfaces = horizontalSurfaces(doc)
    for (const [index, home] of life.folk.entries()) {
      const original = source.folk[index]
      if (!original) {
        throw new Error('Campaign seat source lost an authored actor')
      }
      const seated = home.habit === 'sit' || home.habit === 'whittle'
      expect(seated || home === original).toBe(true)
      if (!seated) {
        continue
      }
      count++
      const heights = heightsAt(surfaces, home.x, home.z)
      expect(heights.some((y) => Math.abs(y - (home.seatY ?? -99)) < 0.003)).toBe(true)
      const floorSurfaces = [...heights, ...heightsAt(shared, home.x, home.z)]
      expect(floorSurfaces.some((y) => Math.abs(y - (home.floor ?? -99)) < 0.003)).toBe(true)
      expect((home.seatY ?? 0) - (home.floor ?? 0)).toBeCloseTo(0.496_151, 6)
      expect([home.x, home.y, home.z, home.yaw]).toEqual([
        original.x,
        original.y,
        original.z,
        original.yaw,
      ])
    }
  }
  expect(count).toBe(12)
})
