import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import accepted from '../fixtures/hardin-accepted-moustache.json' with { type: 'json' }
import {
  body,
  closed,
  fittedErrors,
  hairCorners,
  headPoints,
  key,
  primitive,
  rawCornerSignature,
} from './facial-hair-test-helpers.ts'
import { io } from './paired-grip-test-helpers.ts'

const ART = 'tools/art/characters/beards/outlaw-16.glb'
it('Hardin beard owns exactly the136 open faces and preserves the accepted moustache source', async () => {
  const doc = await io.read('tools/art/characters/outlaw-16.gltf')
  const node = body(doc)
  const original = primitive(node)
  const patch = await io.read(ART)
  await validateAuthoringInputs(patch)
  const surface = patch.getRoot().listMeshes()[0]?.listPrimitives()[0]
  if (!surface) {
    throw new Error('Missing fitted goatee')
  }
  const metadata = patch.getRoot().getExtras() as {
    removeTriangles: number[]
    replaceRanges: unknown[]
  }
  const moustache = await io.read('tools/art/characters/facial-hair/outlaw-16.glb')
  const prior = moustache.getRoot().getExtras() as { removeTriangles: number[] }
  expect(
    createHash('sha256')
      .update(await readFile('tools/art/characters/facial-hair/outlaw-16.glb'))
      .digest('hex'),
  ).toBe(accepted.sourcePortableSHA256)
  expect(metadata.replaceRanges).toEqual([])
  expect(metadata.removeTriangles).toHaveLength(136)
  expect(metadata.removeTriangles.some((face) => prior.removeTriangles.includes(face))).toBe(false)
  const range = (
    node.getExtras().pieceRanges as { name?: string; start: number; count: number }[]
  ).find((r) => r.name === 'Beard')
  const indices = original.getIndices()
  if (!(range && indices)) {
    throw new Error('Missing canonical beard')
  }
  const expected = Array.from({ length: indices.getCount() / 3 }, (_, i) => i).filter(
    (face) =>
      !prior.removeTriangles.includes(face) &&
      [0, 1, 2].every((c) => {
        const i = indices.getScalar(face * 3 + c)
        return i >= range.start && i < range.start + range.count
      }),
  )
  expect(metadata.removeTriangles).toEqual(expected)
  const old = original
    .clone()
    .setIndices(
      indices
        .clone()
        .setArray(
          Uint32Array.from(
            metadata.removeTriangles.flatMap((face) =>
              [0, 1, 2].map((c) => indices.getScalar(face * 3 + c)),
            ),
          ),
        ),
    )
  expect(closed(old)).toBe(false)
  expect(closed(surface)).toBe(true)
  expect((surface.getIndices()?.getCount() ?? 0) / 3).toBeGreaterThan(2000)
  expect((surface.getIndices()?.getCount() ?? 0) / 3).toBeLessThan(20_000)
  const points = headPoints(node, surface)
  expect(Math.max(...points.map((p) => p.y))).toBeLessThan(0.026)
  expect(Math.min(...points.map((p) => p.y))).toBeGreaterThan(-0.045)
  expect(Math.min(...points.map((p) => p.y))).toBeLessThan(-0.025)
  const head = node
    .getSkin()
    ?.listJoints()
    .findIndex((j) => j.getName() === 'Head')
  const joints = surface.getAttribute('_AUTHOR_JOINTS')
  const weights = surface.getAttribute('_AUTHOR_WEIGHTS')
  if (!(joints && weights && head !== undefined && head >= 0)) {
    throw new Error('Missing beard Head binding')
  }
  for (let i = 0; i < joints.getCount(); i++) {
    expect(joints.getElement(i, [] as number[])).toEqual([head, 0, 0, 0])
    expect(weights.getElement(i, [] as number[])).toEqual([1, 0, 0, 0])
  }
})
for (const id of ['outlaw-16', 'outlaw-16.pair']) {
  it(`${id} publishes the closed beard and retains every accepted moustache corner/PBR value`, async () => {
    const source = await io.read('tools/art/characters/outlaw-16.gltf')
    const sourceNode = body(source)
    const patch = await io.read(ART)
    const authored = patch.getRoot().listMeshes()[0]?.listPrimitives()[0]
    if (!authored) {
      throw new Error('Missing authored beard')
    }
    const pub = await io.read(`public/experiments/out-west/3d/native-v2/baked/${id}.glb`)
    const hair = pub
      .getRoot()
      .listNodes()
      .flatMap((node) =>
        (node.getMesh()?.listPrimitives() ?? [])
          .filter((p) => p.getMaterial()?.getName() === 'handlebar-hair')
          .map((surface) => ({ node, surface })),
      )
    expect(hair).toHaveLength(1)
    for (const { node, surface } of hair) {
      const moustache = hairCorners(node, surface, 'moustache')
      const beard = hairCorners(node, surface, 'beard')
      expect(moustache).toHaveLength(11_856)
      const acceptedModel = accepted.models.find((model) => model.id === id)
      if (!acceptedModel) {
        throw new Error('Missing accepted moustache reference')
      }
      expect(rawCornerSignature(surface, moustache)).toBe(acceptedModel.rawTriangleCornerSHA256)
      expect(surface.getMaterial()?.getExtras()).toEqual(accepted.materialExtras)
      expect(beard).toHaveLength(authored.getIndices()?.getCount() ?? 0)
      const points = headPoints(node, surface)
      const actual = [...new Set(beard)].map((i) => {
        const point = points[i]
        if (!point) {
          throw new Error('Missing published beard corner')
        }
        return point
      })
      const expected = [
        ...new Map(headPoints(sourceNode, authored).map((p) => [key(p.toArray()), p])).values(),
      ]
      expect(Math.max(...fittedErrors(actual, expected))).toBeLessThan(0.0002)
      expect(pub.getRoot().listTextures()).toHaveLength(0)
    }
  })
}
