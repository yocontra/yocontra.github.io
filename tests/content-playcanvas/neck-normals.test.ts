import { expect, test as it } from 'bun:test'
import { type Accessor, Document, NodeIO } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'
import { repairHeadNape } from '../../tools/content/head-nape.ts'

const io = new NodeIO()
function faceAreas(
  position: Accessor,
  indices: Accessor,
  range: { start: number; count: number },
): Map<string, Vec3> {
  const key = (i: number) => position.getElement(i, []).join(',')
  const areas = new Map<string, Vec3>()
  for (let i = 0; i < indices.getCount(); i += 3) {
    const face = [0, 1, 2].map((corner) => indices.getScalar(i + corner))
    if (!face.every((vertex) => vertex >= range.start && vertex < range.start + range.count)) {
      continue
    }
    const points = face.map((vertex) => new Vec3(...position.getElement(vertex, [])))
    const [a, b, c] = points
    if (!(a && b && c)) {
      throw new Error('Incomplete head triangle')
    }
    const area = new Vec3().cross(b.clone().sub(a), c.clone().sub(a))
    for (const vertex of face) {
      const shared = areas.get(key(vertex)) ?? new Vec3()
      areas.set(key(vertex), shared.add(area))
    }
  }
  return areas
}
for (const id of ['player', 'outlaw-8']) {
  it(`${id} neck normals follow its actual deformed surface and preserve skin boundaries`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    const body = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getSkin() && n.getExtras().pieceRanges)
    const primitive = body?.getMesh()?.listPrimitives()[0]
    const skin = body?.getSkin()
    const head = skin?.listJoints().find((joint) => joint.getName() === 'Head')
    const position = primitive?.getAttribute('POSITION')
    const normal = primitive?.getAttribute('NORMAL')
    const indices = primitive?.getIndices()
    const range = (
      body?.getExtras().pieceRanges as { start: number; count: number }[] | undefined
    )?.[0]
    if (!(primitive && head && position && normal && indices && range && skin)) {
      throw new Error('Missing native head source')
    }
    const origin = head.getWorldMatrix().slice(12, 15)
    const originalNormals = Array.from(normal.getArray() ?? [])
    const original = primitive
      .listSemantics()
      .filter((name) => !['POSITION', 'NORMAL'].includes(name))
      .map((name) => [name, Array.from(primitive.getAttribute(name)?.getArray() ?? [])])
    const rig = JSON.stringify(
      skin.listJoints().map((joint) => [joint.getName(), joint.getMatrix()]),
    )
    await repairHeadNape(doc)
    expect(
      primitive
        .listSemantics()
        .filter((name) => !['POSITION', 'NORMAL'].includes(name))
        .map((name) => [name, Array.from(primitive.getAttribute(name)?.getArray() ?? [])]),
    ).toEqual(original)
    expect(
      JSON.stringify(skin.listJoints().map((joint) => [joint.getName(), joint.getMatrix()])),
    ).toBe(rig)
    // Independent area-weighted face reference; production uses the engine's
    // equal-face normal calculation. Both must agree on the broad cervical shape.
    const key = (i: number) => position.getElement(i, []).join(',')
    const areas = faceAreas(position, indices, range)
    const errors: number[] = []
    const seams = new Map<string, number[]>()
    let boundaryDelta = 0
    let seamDelta = 0
    for (let i = range.start; i < range.start + range.count; i++) {
      const p = position.getElement(i, []).map((value, k) => value - (origin[k] ?? 0))
      const n = normal.getElement(i, [])
      expect(Math.hypot(...n)).toBeCloseTo(1, 5)
      const [x = 0, y = 0, z = 0] = p
      if (z >= 0.01 || Math.abs(x) >= 0.075 || y <= -0.06 || y >= 0.095) {
        boundaryDelta = Math.max(
          boundaryDelta,
          ...n.map((v, k) => Math.abs(v - (originalNormals[i * 3 + k] ?? 0))),
        )
      }
      if (y >= -0.04 && y <= 0.05 && z < -0.025 && Math.abs(x) < 0.045) {
        const reference = areas.get(key(i))?.clone().normalize()
        if (!reference) {
          throw new Error('Missing cervical face reference')
        }
        errors.push(
          (Math.acos(Math.max(-1, Math.min(1, reference.dot(new Vec3(...n).normalize())))) * 180) /
            Math.PI,
        )
      }
      if (y >= -0.06 && y <= 0.065 && z < -0.005) {
        const previous = seams.get(key(i))
        if (previous) {
          seamDelta = Math.max(
            seamDelta,
            ...n.map((value, k) => Math.abs(value - (previous[k] ?? 0))),
          )
        }
        seams.set(key(i), n)
      }
    }
    expect(seamDelta).toBe(0)
    expect(errors.length).toBeGreaterThan(40)
    expect(Math.max(...errors)).toBeLessThan(10)
    expect(boundaryDelta).toBe(0)
    expect(errors.reduce((sum, error) => sum + error, 0) / errors.length).toBeLessThan(2)
    expect(Array.from(normal.getArray() ?? []).slice((range.start + range.count) * 3)).toEqual(
      originalNormals.slice((range.start + range.count) * 3),
    )
  })
}

it('normal reconstruction keeps nearby separate skin surfaces distinct', async () => {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const points = [
    -0.01, -0.01, -0.05, 0.01, -0.01, -0.05, 0, 0.01, -0.05, -0.01, -0.01, -0.050_000_2, 0.01,
    -0.01, -0.050_000_2, 0, 0.01, -0.050_000_2, 0, 0.2, 0,
  ]
  const positions = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(Float32Array.from(points))
  const normals = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 1, 0]))
  const indices = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('SCALAR')
    .setArray(Uint16Array.from([0, 1, 2, 3, 5, 4]))
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setAttribute('NORMAL', normals)
    .setIndices(indices)
  const head = doc.createNode('Head')
  const skin = doc.createSkin().addJoint(head).setSkeleton(head)
  const body = doc
    .createNode('Character')
    .setMesh(doc.createMesh().addPrimitive(primitive))
    .setSkin(skin)
    .setExtras({ pieceRanges: [{ start: 0, count: 7, slot: 'skin' }] })
  doc.createScene().addChild(head).addChild(body)
  await repairHeadNape(doc)
  const front = new Vec3(...normals.getElement(0, [])).normalize()
  const back = new Vec3(...normals.getElement(3, [])).normalize()
  expect(front.dot(back)).toBeLessThan(-0.99)
  expect(Math.hypot(...normals.getElement(0, []))).toBeCloseTo(1, 5)
  expect(Math.hypot(...normals.getElement(3, []))).toBeCloseTo(1, 5)
})
