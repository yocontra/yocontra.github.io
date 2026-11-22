import { expect, test as it } from 'bun:test'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import type { Range } from '../../tools/content/character-atlas.ts'
import { authorFirstPersonSleeves } from '../../tools/content/first-person-sleeves.ts'
import { integrateGarmentParts } from '../../tools/content/garment-parts.ts'
import { hangTimeout } from '../timeout.ts'

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
for (const [id, donorId, vertices, faces, worldFaces, shirtFaces] of [
  ['outfit.striped-poncho', 'outfit.shirt-vest', 578, 1088, 51, 892],
  ['outfit.striped-poncho.pair', 'outfit.shirt-vest', 578, 1088, 72, 862],
  ['outlaw-6', 'outfit.shirt-vest', 578, 1088, 51, 895],
  ['outlaw-15', 'outlaw-2', 544, 1024, 43, 907],
] as const) {
  it(`${id} restores the shirt and neck under the woven poncho`, async () => {
    const artifact = await io.read(`tools/art/characters/coat-collars/${id}.glb`)
    await validateAuthoringInputs(artifact)
    const shell = artifact.getRoot().listMeshes()[0]?.listPrimitives()[0]
    const pieces = shell?.getExtras().pieceRanges as Range[] | undefined
    const [woven, neck, hem, shirt] = pieces ?? []
    const joints = shell?.getAttribute('_AUTHOR_JOINTS')
    const weights = shell?.getAttribute('_AUTHOR_WEIGHTS')
    if (!(shell && woven && neck && hem && shirt && joints && weights)) {
      throw new Error('Missing fitted poncho shell, fringe or restored layers')
    }
    expect(woven).toMatchObject({ start: 0, count: 1120, swatch: 'hessian' })
    expect(neck).toMatchObject({ start: 1120, slot: 'skin', name: 'RestoredPonchoNeck' })
    expect(indices(shell, woven)).toHaveLength(2184 * 3)
    expect(indices(shell, neck)).toHaveLength((id === 'outlaw-15' ? 44 : 42) * 3)
    expect(hem).toMatchObject({ name: 'Rolled woven hem and knotted fringe', swatch: 'hessian' })
    expect(indices(shell, hem)).toHaveLength(504 * 3)
    expect(shirt).toMatchObject({ name: 'WesternShirt', slot: 'shirt' })
    expect(indices(shell, shirt)).toHaveLength((id === 'outlaw-15' ? 960 : 952) * 3)
    expect(artifact.getRoot().getExtras().ponchoFit).toMatchObject({
      restoredLinenTriangles: shirtFaces,
    })
    const names = artifact.getRoot().getExtras().jointNames as string[]
    for (let vertex = 0; vertex < 28; vertex++) {
      const weightsAt = weights.getElement(vertex, [])
      expect(weightsAt.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6)
      expect(
        joints
          .getElement(vertex, [])
          .flatMap((joint, slot) => ((weightsAt[slot] ?? 0) > 0 ? [names[joint]] : [])),
      ).toEqual(['Chest', 'Neck'])
    }
  })
  it(`${id} keeps the center back panel against the ribcage`, async () => {
    const canonical = body(await io.read(`tools/art/characters/${id}.gltf`))
    const skin = canonical.node.getSkin()
    const head = skin?.listJoints().findIndex((joint) => joint.getName() === 'Head') ?? -1
    const inverse = skin?.getInverseBindMatrices()
    const source = canonical.primitive.getAttribute('POSITION')
    const artifact = await io.read(`tools/art/characters/coat-collars/${id}.glb`)
    const cloth = artifact.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute('POSITION')
    if (!(inverse && source && cloth) || head < 0) {
      throw new Error('Missing poncho fit positions or head bind transform')
    }
    const headLocal = new Mat4().set(inverse.getElement(head, []))
    const sample = new Vec3()
    const point = new Vec3()
    let crown = 0
    for (let vertex = 0; vertex < 1555; vertex++) {
      sample.set(...source.getElement<[number, number, number]>(vertex, [0, 0, 0]))
      crown = Math.max(crown, headLocal.transformPoint(sample, point).y)
    }
    let back = 0
    // The original woven panel is the first 1120 vertices. The skin and fringe follow it.
    for (let vertex = 0; vertex < 1120; vertex++) {
      sample.set(...cloth.getElement<[number, number, number]>(vertex, [0, 0, 0]))
      headLocal.transformPoint(sample, point)
      if (Math.abs(point.x) < 0.5 * crown && point.y < -0.65 * crown && point.y > -2 * crown) {
        back = Math.max(back, -point.z / crown)
      }
    }
    expect(back).toBeGreaterThan(0.67)
    expect(back).toBeLessThan(0.84)
  })
  it(
    `${id} uses complete sleeves with a separate fit for world and first-person arms`,
    async () => {
      const world = await io.read(`tools/art/characters/${id}.gltf`)
      const presentation = await io.read(`tools/art/characters/${id}.gltf`)
      const original = body(presentation)
      const incomplete = indices(original.primitive, original.range)
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
      // Both fits recover the original sleeve topology. Only the world fit changes its positions.
      expect(incomplete).toHaveLength(worldFaces * 3)
      expect(complete).toHaveLength(faces * 3)
      expect(indices(before.primitive, before.range)).toEqual(complete)
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
      // Both paths preserve the surfaces outside the sleeves, the rig, and the clips.
      expect(outside(after.primitive, after.range)).toEqual(outside(before.primitive, before.range))
      for (const semantic of before.primitive.listSemantics()) {
        const a = before.primitive.getAttribute(semantic)
        const b = after.primitive.getAttribute(semantic)
        if (!(a && b)) {
          throw new Error('Lost world stream')
        }
        const first = Array.from(a.getArray() ?? [])
        const second = Array.from(b.getArray() ?? [])
        const position = semantic === 'POSITION'
        const start = position ? before.range.start * a.getElementSize() : first.length
        const end = position ? start + before.range.count * a.getElementSize() : start
        expect(first.slice(0, start)).toEqual(second.slice(0, start))
        expect(first.slice(end)).toEqual(second.slice(end))
        expect(
          JSON.stringify(first.slice(start, end)) !== JSON.stringify(second.slice(start, end)),
        ).toBe(position)
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
      const worn = await io.read(`tools/art/characters/poncho-sleeves/${id}.glb`)
      await validateAuthoringInputs(worn)
      expect(worn.getRoot().getExtras().restoredSleeveTriangles).toBe(faces - worldFaces)
      const portable = await io.read(`tools/art/characters/first-person-sleeves/${id}.glb`)
      await validateAuthoringInputs(portable)
      expect(await io.writeBinary(await authorFirstPersonSleeves(id))).toEqual(
        await io.writeBinary(portable),
      )
      expect(portable.getRoot().getExtras().replaceRanges).toEqual([original.range])
      expect(portable.getRoot().getExtras().removeTriangles).toEqual([])
    },
    hangTimeout(10_000),
  )
}
