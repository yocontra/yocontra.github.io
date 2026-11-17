import { expect, test as it } from 'bun:test'
import { NodeIO, type Primitive } from '@gltf-transform/core'
import { integrateGarmentParts } from '../../tools/content/garment-parts.ts'

const io = new NodeIO()
function clothMetrics(authored: Primitive): { closed: boolean; volume: number } {
  const position = authored.getAttribute('POSITION')
  if (!position) {
    throw new Error('Missing cloth position')
  }
  // Every geometric edge has its opposite after welding coincident UV/normal seams.
  const indices = authored.getIndices()
  const edgeCounts = new Map<string, number>()
  let volume = 0
  if (!indices) {
    throw new Error('No cloth triangles')
  }
  const key = (i: number) =>
    position
      .getElement(i, [])
      .map((v) => Math.round(v * 1e7))
      .join(',')
  for (let i = 0; i < indices.getCount(); i += 3) {
    const [a, b, c] = [0, 1, 2].map((corner) =>
      position.getElement(indices.getScalar(i + corner), []),
    )
    if (!(a && b && c)) {
      throw new Error('Missing solid cloth triangle')
    }
    volume +=
      ((a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0)) +
        (a[1] ?? 0) * ((b[2] ?? 0) * (c[0] ?? 0) - (b[0] ?? 0) * (c[2] ?? 0)) +
        (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0))) /
      6
    for (let j = 0; j < 3; j++) {
      const edge = [key(indices.getScalar(i + j)), key(indices.getScalar(i + ((j + 1) % 3)))]
        .sort((left, right) => left.localeCompare(right))
        .join('|')
      edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1)
    }
  }
  return { closed: [...edgeCounts.values()].every((n) => n === 2), volume }
}
function fixedFrontMetrics(
  primitive: Primitive,
  authored: Primitive,
  range: { start: number; count: number },
  jointCount: number,
): { vertices: number; maximumInfluenceError: number } {
  const position = authored.getAttribute('POSITION')
  const joints = authored.getAttribute('_AUTHOR_JOINTS')
  const weights = authored.getAttribute('_AUTHOR_WEIGHTS')
  const sourcePosition = primitive.getAttribute('POSITION')
  if (!(position && joints && weights && sourcePosition)) {
    throw new Error('Missing cloth surface')
  }
  // The fixed front edge must keep the bib's original skinning as well as its position.
  const sourceJoints = primitive.getAttribute('JOINTS_0')
  const sourceWeights = primitive.getAttribute('WEIGHTS_0')
  if (!(sourceJoints && sourceWeights)) {
    throw new Error('Missing original cloth skinning')
  }
  let fixedFrontVertices = 0
  let maximumInfluenceError = 0
  for (let i = 0; i < position.getCount(); i++) {
    const point = position.getElement(i, [])
    const sourceVertex = Array.from({ length: range.count }, (_, j) => range.start + j).find((j) =>
      sourcePosition.getElement(j, []).every((v, axis) => Math.abs(v - (point[axis] ?? 0)) < 1e-7),
    )
    if (sourceVertex === undefined) {
      continue
    }
    fixedFrontVertices++
    const originalJoints = sourceJoints.getElement(sourceVertex, [])
    const originalWeights = sourceWeights.getElement(sourceVertex, [])
    const actualJoints = joints.getElement(i, [])
    const actualWeights = weights.getElement(i, [])
    for (let joint = 0; joint < jointCount; joint++) {
      const influence = (ids: number[], amounts: number[]) =>
        ids.reduce(
          (total, jointIndex, k) => total + (jointIndex === joint ? (amounts[k] ?? 0) : 0),
          0,
        )
      maximumInfluenceError = Math.max(
        maximumInfluenceError,
        Math.abs(
          influence(actualJoints, actualWeights) - influence(originalJoints, originalWeights),
        ),
      )
    }
  }
  return { vertices: fixedFrontVertices, maximumInfluenceError }
}
for (const id of [
  'player',
  'outfit.trail-duds',
  'outfit.trail-duds.pair',
  'outlaw-5',
  'outlaw-6',
  'outlaw-13',
  'outlaw-15',
  'extra.red-bandana',
  'extra.black-bandana',
]) {
  it(`${id} fits only the neck band with closed thickness and preserves the bib, skin and rig`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    const node = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getSkin() && n.getExtras().pieceRanges)
    const primitive = node?.getMesh()?.listPrimitives()[0]
    const skin = node?.getSkin()
    if (!(node && primitive && skin)) {
      throw new Error('Missing source body')
    }
    const artifact = await io.read(`tools/art/characters/neckerchiefs/${id}.glb`)
    const authored = artifact.getRoot().listMeshes()[0]?.listPrimitives()[0]
    if (!authored) {
      throw new Error('Missing cloth surface')
    }
    const position = authored.getAttribute('POSITION')
    const joints = authored.getAttribute('_AUTHOR_JOINTS')
    const weights = authored.getAttribute('_AUTHOR_WEIGHTS')
    if (!(position && joints && weights)) {
      throw new Error('Missing native skin')
    }
    const metadata = artifact.getRoot().getExtras() as {
      replaceRanges: { start: number; count: number }[]
      neckerchiefFit: { thicknessMM: number }
    }
    const range = metadata.replaceRanges[0]
    if (!range) {
      throw new Error('Missing replacement boundary')
    }
    expect(range.count).toBe(72)
    expect(metadata.neckerchiefFit.thicknessMM).toBe(1.5)
    const before: [string, number[]][] = primitive
      .listSemantics()
      .map((s) => [s, Array.from(primitive.getAttribute(s)?.getArray() ?? [])])
    const sourcePosition = primitive.getAttribute('POSITION')
    const sourceIndices = primitive.getIndices()
    if (!(sourcePosition && sourceIndices)) {
      throw new Error('Missing canonical cloth')
    }
    const oldRear = Math.min(
      ...Array.from(
        { length: range.count },
        (_, i) => sourcePosition.getElement(range.start + i, [])[2] ?? 0,
      ),
    )
    const newRear = Math.min(
      ...Array.from({ length: position.getCount() }, (_, i) => position.getElement(i, [])[2] ?? 0),
    )
    expect(newRear - oldRear).toBeGreaterThan(0.015)
    const front = fixedFrontMetrics(primitive, authored, range, skin.listJoints().length)
    expect(front.vertices).toBeGreaterThan(3)
    expect(front.maximumInfluenceError).toBeLessThan(5e-7)
    const sourceRanges = node.getExtras().pieceRanges as {
      start: number
      count: number
      swatch?: string
      name?: string
      slot?: string
    }[]
    const bibs = sourceRanges.filter(
      (piece) => piece.swatch === 'linen' && !piece.slot && !piece.name && piece.count !== 72,
    )
    const bibFaces: number[][] = []
    for (let i = 0; i < sourceIndices.getCount(); i += 3) {
      const face = [0, 1, 2].map((corner) => sourceIndices.getScalar(i + corner))
      if (
        bibs.some((piece) =>
          face.every((vertex) => vertex >= piece.start && vertex < piece.start + piece.count),
        )
      ) {
        bibFaces.push(face)
      }
    }
    expect(bibFaces.length).toBeGreaterThan(0)
    const rig = JSON.stringify([
      skin.getInverseBindMatrices()?.getArray(),
      skin
        .listJoints()
        .map((j) => [j.getName(), j.getTranslation(), j.getRotation(), j.getScale()]),
      doc
        .getRoot()
        .listAnimations()
        .map((a) => [
          a.getName(),
          a.listSamplers().map((s) => [s.getInput()?.getArray(), s.getOutput()?.getArray()]),
        ]),
    ])
    await integrateGarmentParts(doc, id)
    const indicesAfter = primitive.getIndices()
    if (!indicesAfter) {
      throw new Error('Missing integrated cloth')
    }
    const allFaces = new Set(
      Array.from({ length: indicesAfter.getCount() / 3 }, (_, i) =>
        [0, 1, 2].map((corner) => indicesAfter.getScalar(i * 3 + corner)).join(','),
      ),
    )
    expect(bibFaces.every((face) => allFaces.has(face.join(',')))).toBe(true)
    expect(
      Array.from(indicesAfter.getArray() ?? []).every(
        (vertex) => vertex < range.start || vertex >= range.start + range.count,
      ),
    ).toBe(true)
    // Portable replacements append their own streams; canonical body/bib streams stay exact.
    for (const [semantic, values] of before) {
      expect(
        Array.from(primitive.getAttribute(semantic as string)?.getArray() ?? []).slice(
          0,
          (values as number[]).length,
        ),
      ).toEqual(values)
    }
    expect(
      JSON.stringify([
        skin.getInverseBindMatrices()?.getArray(),
        skin
          .listJoints()
          .map((j) => [j.getName(), j.getTranslation(), j.getRotation(), j.getScale()]),
        doc
          .getRoot()
          .listAnimations()
          .map((a) => [
            a.getName(),
            a.listSamplers().map((s) => [s.getInput()?.getArray(), s.getOutput()?.getArray()]),
          ]),
      ]),
    ).toBe(rig)
    for (let i = 0; i < position.getCount(); i++) {
      expect(position.getElement(i, []).every(Number.isFinite)).toBe(true)
      expect(weights.getElement(i, []).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
      for (const joint of joints.getElement(i, [])) {
        expect(joint).toBeLessThan(skin.listJoints().length)
      }
    }
    const metrics = clothMetrics(authored)
    expect(metrics.closed).toBe(true)
    expect(metrics.volume).toBeGreaterThan(0.000_005)
    expect(metrics.volume).toBeLessThan(0.000_04)
    const original = node.getExtras().pieceRanges as { start: number; count: number }[]
    expect(original.some((r) => r.start === range.start && r.count === range.count)).toBe(true)
  })
}
