import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { repairHeadNape } from '../../tools/content/head-nape.ts'

const io = new NodeIO()

/** Ray/triangle intersections measure the rendered contour without using its authored field. */
function posterior(points: number[][], faces: number[][], x: number, y: number): number {
  let depth = Number.POSITIVE_INFINITY
  for (const face of faces) {
    const [a, b, c] = face.map((vertex) => points[vertex])
    if (!(a && b && c)) {
      throw new Error('Missing neck contour triangle')
    }
    const [ax = 0, ay = 0, az = 0] = a
    const [bx = 0, by = 0, bz = 0] = b
    const [cx = 0, cy = 0, cz = 0] = c
    const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(determinant) < 1e-12) {
      continue
    }
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) {
      depth = Math.min(depth, u * az + v * bz + (1 - u - v) * cz)
    }
  }
  if (!Number.isFinite(depth)) {
    throw new Error('Missing posterior skin surface')
  }
  return depth
}

for (const id of ['player', 'outlaw-8']) {
  it(`${id} has a continuous posterior neck contour at the center and both sides`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    await repairHeadNape(doc)
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
      throw new Error('Missing canonical head contour')
    }
    const origin = head.getWorldMatrix().slice(12, 15)
    const points = Array.from({ length: range.count }, (_, i) =>
      position.getElement(range.start + i, []).map((value, k) => value - (origin[k] ?? 0)),
    )
    const scale = Math.max(...points.map((point) => point[1] ?? 0)) / 0.199_726_505_927_274_6
    const normalized = points.map((point) => point.map((value) => value / scale))
    const faces: number[][] = []
    for (let i = 0; i < indices.getCount(); i += 3) {
      const face = [0, 1, 2].map((corner) => indices.getScalar(i + corner) - range.start)
      if (face.every((vertex) => vertex >= 0 && vertex < range.count)) {
        faces.push(face)
      }
    }
    for (const x of [-0.03, 0, 0.03]) {
      const contour = Array.from({ length: 23 }, (_, i) =>
        posterior(normalized, faces, x, -0.04 + i * 0.005),
      )
      const bends = contour
        .slice(1, -1)
        .map((z, i) => Math.abs((contour[i] ?? 0) - 2 * z + (contour[i + 2] ?? 0)))
      // The old lateral shelf changed direction by up to2.84mm over adjacent5mm samples.
      expect(Math.max(...bends)).toBeLessThan(0.0012)
    }
  })
}
