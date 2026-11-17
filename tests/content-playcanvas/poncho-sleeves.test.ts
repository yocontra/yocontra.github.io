import { expect, test as it } from 'bun:test'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import type { Range } from '../../tools/content/character-atlas.ts'
import { authorFirstPersonSleeves } from '../../tools/content/first-person-sleeves.ts'
import { integrateGarmentParts } from '../../tools/content/garment-parts.ts'

const io = new NodeIO()
function body(doc: Document) {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getExtras().pieceRanges && n.getSkin())
  const primitive = node
    ?.getMesh()
    ?.listPrimitives()
    .find((p) => p.getAttribute('_STYLE_LUMINANCE'))
  if (!(node && primitive)) {
    throw new Error('No canonical fitted body')
  }
  const ranges = (primitive.getExtras().pieceRanges ?? node.getExtras().pieceRanges) as Range[]
  const range = ranges.findLast((r) => r.name === 'WesternSleeves')
  if (!range) {
    throw new Error('No fitted sleeve range')
  }
  return { node, primitive, range }
}
function indices(primitive: Primitive, range: Range): number[] {
  const ix = primitive.getIndices()
  if (!ix) {
    throw new Error('No indexed cloth')
  }
  const out: number[] = []
  for (let i = 0; i < ix.getCount(); i += 3) {
    const t = [0, 1, 2].map((c) => ix.getScalar(i + c))
    if (t.every((v) => v >= range.start && v < range.start + range.count)) {
      out.push(...t.map((v) => v - range.start))
    }
  }
  return out
}
function rigAndClips(doc: Document): string {
  return JSON.stringify({
    nodes: doc
      .getRoot()
      .listNodes()
      .map((n) => [n.getName(), n.getMatrix(), n.getExtras(), n.getParentNode()?.getName()]),
    skins: doc
      .getRoot()
      .listSkins()
      .map((s) => [s.listJoints().map((j) => j.getName()), s.getInverseBindMatrices()?.getArray()]),
    clips: doc
      .getRoot()
      .listAnimations()
      .map((a) => [
        a.getName(),
        a
          .listChannels()
          .map((c) => [
            c.getTargetNode()?.getName(),
            c.getTargetPath(),
            c.getSampler()?.getInterpolation(),
            c.getSampler()?.getInput()?.getArray(),
            c.getSampler()?.getOutput()?.getArray(),
          ]),
      ]),
  })
}
function outside(primitive: Primitive, range: Range): number[] {
  const ix = primitive.getIndices()
  if (!ix) {
    throw new Error('Missing indices')
  }
  const out: number[] = []
  for (let i = 0; i < ix.getCount(); i += 3) {
    const triangle = [0, 1, 2].map((c) => ix.getScalar(i + c))
    if (!triangle.every((v) => v >= range.start && v < range.start + range.count)) {
      out.push(...triangle)
    }
  }
  return out
}
function edges(values: number[]): Map<string, number> {
  const result = new Map<string, number>()
  for (let i = 0; i < values.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const key = [values[i + c] ?? 0, values[i + ((c + 1) % 3)] ?? 0]
        .sort((a, b) => a - b)
        .join('/')
      result.set(key, (result.get(key) ?? 0) + 1)
    }
  }
  return result
}
for (const [id, donorId, vertices, faces, worldFaces] of [
  ['outfit.striped-poncho', 'outfit.shirt-vest', 578, 1088, 51],
  ['outfit.striped-poncho.pair', 'outfit.shirt-vest', 578, 1088, 72],
  ['outlaw-6', 'outfit.shirt-vest', 578, 1088, 51],
  ['outlaw-15', 'outlaw-2', 544, 1024, 43],
] as const) {
  it(`${id} completes only the presentation sleeve with its own fitted attributes and the donor's full adjacency`, async () => {
    const world = await io.read(`tools/art/characters/${id}.gltf`)
    const presentation = await io.read(`tools/art/characters/${id}.gltf`)
    const original = body(presentation)
    const rig = rigAndClips(presentation)
    const ownAttributes = original.primitive.listSemantics().map((semantic) => ({
      semantic,
      values: Array.from({ length: vertices }, (_, v) =>
        original.primitive.getAttribute(semantic)?.getElement(original.range.start + v, []),
      ),
    }))
    const donor = body(await io.read(`tools/art/characters/${donorId}.gltf`))
    await integrateGarmentParts(world, id)
    await integrateGarmentParts(presentation, id, { firstPersonSleeves: true })
    const before = body(world)
    const after = body(presentation)
    const complete = indices(after.primitive, after.range)
    const incomplete = indices(before.primitive, before.range)
    // The default producer is the old-code control: world occlusion is deliberate.
    expect(incomplete).toHaveLength(worldFaces * 3)
    expect(complete).toHaveLength(faces * 3)
    expect(complete).toEqual(indices(donor.primitive, donor.range))
    expect(after.range).toMatchObject({
      count: vertices,
      slot: 'sleeves',
      swatch: 'linen',
      name: 'WesternSleeves',
    })
    expect(
      new Set(Array.from({ length: faces }, (_, f) => complete.slice(f * 3, f * 3 + 3).join('/')))
        .size,
    ).toBe(faces)
    const fullEdges = edges(complete)
    expect(
      [...edges(incomplete)].filter(([edge, count]) => count === 1 && fullEdges.get(edge) === 2)
        .length,
    ).toBeGreaterThan(10)
    // No world surface, cape, original attribute, rig or clip is altered.
    expect(outside(after.primitive, after.range)).toEqual(outside(before.primitive, before.range))
    for (const semantic of before.primitive.listSemantics()) {
      const a = before.primitive.getAttribute(semantic)
      const b = after.primitive.getAttribute(semantic)
      if (!(a && b)) {
        throw new Error('Lost world stream')
      }
      expect(Array.from(b.getArray()?.slice(0, a.getArray()?.length) ?? [])).toEqual(
        Array.from(a.getArray() ?? []),
      )
    }
    for (const { semantic, values } of ownAttributes) {
      const attribute = after.primitive.getAttribute(semantic)
      expect(
        Array.from({ length: vertices }, (_, v) =>
          attribute?.getElement(after.range.start + v, []),
        ),
      ).toEqual(values)
    }
    expect(rigAndClips(presentation)).toBe(rig)
    const portable = await io.read(`tools/art/characters/first-person-sleeves/${id}.glb`)
    await validateAuthoringInputs(portable)
    expect(await io.writeBinary(await authorFirstPersonSleeves(id))).toEqual(
      await io.writeBinary(portable),
    )
    expect(portable.getRoot().getExtras().replaceRanges).toEqual([original.range])
    expect(portable.getRoot().getExtras().removeTriangles).toEqual([])
  })
}
