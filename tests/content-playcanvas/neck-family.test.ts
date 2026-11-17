import { expect, test as it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'
import { repairHeadNape } from '../../tools/content/head-nape.ts'

const io = new NodeIO()
const HUMAN_SOURCE = /^(?:player|outlaw-\d+|outfit\.[a-z.-]+)\.gltf$/u
const ids = (await readdir('tools/art/characters')).filter((name) => HUMAN_SOURCE.test(name))
it('the neck geometry guard covers all 34 canonical bodies', () => {
  expect(ids).toHaveLength(34)
})

function triangleArea(points: number[][], face: number[]): Vec3 {
  const [a, b, c] = face.map((vertex) => {
    const point = points[vertex]
    if (!point) {
      throw new Error('Missing cervical vertex')
    }
    return new Vec3(...point)
  })
  if (!(a && b && c)) {
    throw new Error('Missing cervical triangle')
  }
  return new Vec3().cross(b.sub(a), c.sub(a))
}

for (const id of ids) {
  it(`${id} neck taper preserves its shape anchors and triangle orientation`, async () => {
    const doc = await io.read(`tools/art/characters/${id}`)
    const body = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'Character' && node.getSkin())
    const primitive = body?.getMesh()?.listPrimitives()[0]
    const position = primitive?.getAttribute('POSITION')
    const indices = primitive?.getIndices()
    const head = body
      ?.getSkin()
      ?.listJoints()
      .find((joint) => joint.getName() === 'Head')
    const range = (
      body?.getExtras().pieceRanges as { start: number; count: number }[] | undefined
    )?.[0]
    if (!(position && indices && head && range)) {
      throw new Error('Missing canonical head geometry')
    }
    const original = Array.from(position.getArray() ?? [])
    const before = Array.from({ length: range.count }, (_, i) =>
      position.getElement(range.start + i, []),
    )
    const origin = head.getWorldMatrix().slice(12, 15)
    const scale =
      (Math.max(...before.map((point) => point[1] ?? 0)) - (origin[1] ?? 0)) /
      0.199_726_505_927_274_6
    await repairHeadNape(doc)
    const after = before.map((_, i) => position.getElement(range.start + i, []))
    let anchorChanges = 0
    let changed = 0
    let maximum = 0
    for (const [i, point] of before.entries()) {
      const next = after[i] ?? []
      const [x = 0, y = 0, z = 0] = point.map((value, k) => (value - (origin[k] ?? 0)) / scale)
      const distance = Math.hypot(...point.map((value, k) => value - (next[k] ?? 0)))
      expect(next[1]).toBe(point[1])
      if (distance > 0) {
        changed++
        maximum = Math.max(maximum, distance)
        if (Math.abs(x) >= 0.075 || y <= -0.06 || y >= 0.085 || z >= -0.005) {
          anchorChanges++
        }
      }
    }
    expect(anchorChanges).toBe(0)
    expect(changed).toBeGreaterThan(60)
    expect(maximum).toBeLessThan(scale * 0.025)
    expect(Array.from(position.getArray() ?? []).slice((range.start + range.count) * 3)).toEqual(
      original.slice((range.start + range.count) * 3),
    )
    let reversed = 0
    let minimumArea = Number.POSITIVE_INFINITY
    for (let i = 0; i < indices.getCount(); i += 3) {
      const face = [0, 1, 2].map((corner) => indices.getScalar(i + corner) - range.start)
      if (!face.every((vertex) => vertex >= 0 && vertex < range.count)) {
        continue
      }
      const old = triangleArea(before, face)
      if (old.length() <= 1e-10) {
        continue
      }
      const next = triangleArea(after, face)
      minimumArea = Math.min(minimumArea, next.length() / old.length())
      if (old.dot(next) <= 0) {
        reversed++
      }
    }
    expect(reversed).toBe(0)
    expect(minimumArea).toBeGreaterThan(0.25)
  })
}
