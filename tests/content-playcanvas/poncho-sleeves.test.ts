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
function measureSleeveFit(original: ReturnType<typeof body>, fitted: ReturnType<typeof body>) {
  const skin = original.node.getSkin()
  const inverse = skin?.getInverseBindMatrices()
  const before = original.primitive.getAttribute('POSITION')
  const after = fitted.primitive.getAttribute('POSITION')
  if (!(skin && inverse && before && after)) {
    throw new Error('Missing sleeve positions or arm bind transforms')
  }
  const joints = skin.listJoints()
  const bind = (name: string) => {
    const index = joints.findIndex((joint) => joint.getName() === name)
    if (index < 0) {
      throw new Error(`Missing bind transform for ${name}`)
    }
    return new Mat4().set(inverse.getElement(index, []))
  }
  const head = bind('Head')
  return ['L', 'R'].map((side) => {
    const pivot = (bone: string) =>
      head.transformPoint(
        bind(bone + side)
          .invert()
          .getTranslation(),
      )
    const shoulder = pivot('UpperArm')
    const elbow = pivot('LowerArm')
    const wrist = pivot('Wrist')
    const upper = elbow.clone().sub(shoulder)
    const lower = wrist.clone().sub(elbow)
    const relative = new Vec3()
    let originalRadius = 0
    let fittedRadius = 0
    const cuff: { along: number; drift: number }[] = []
    for (let i = 0; i < original.range.count; i++) {
      const p = head.transformPoint(new Vec3(before.getElement(original.range.start + i, [])))
      if (p.x > 0 !== (side === 'L')) {
        continue
      }
      const q = head.transformPoint(new Vec3(after.getElement(fitted.range.start + i, [])))
      const upperT = relative.sub2(p, shoulder).dot(upper) / upper.lengthSq()
      if (upperT > 0.2 && upperT < 0.57) {
        const radius = (point: Vec3) =>
          new Vec3().cross(relative.sub2(point, shoulder), upper).length()
        originalRadius += radius(p)
        fittedRadius += radius(q)
      }
      const foreT = relative.sub2(p, elbow).dot(lower) / lower.lengthSq()
      cuff.push({ along: foreT, drift: q.distance(p) })
    }
    // The distal vertices define the cuff even when the sleeve ends short of the joint.
    const cuffEdge = cuff.sort((a, b) => b.along - a.along).slice(0, 12)
    return { originalRadius, fittedRadius, cuffEdge }
  })
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
  it(`${id} drapes across the shoulder and falls past the belt without a shelf`, async () => {
    const canonical = body(await io.read(`tools/art/characters/${id}.gltf`))
    const skin = canonical.node.getSkin()
    const head = skin?.listJoints().findIndex((joint) => joint.getName() === 'Head') ?? -1
    const inverse = skin?.getInverseBindMatrices()
    const source = canonical.primitive.getAttribute('POSITION')
    const artifact = await io.read(`tools/art/characters/coat-collars/${id}.glb`)
    const panel = artifact.getRoot().listMeshes()[0]?.listPrimitives()[0]
    const cloth = panel?.getAttribute('POSITION')
    const uv = panel?.getAttribute('TEXCOORD_0')
    if (!(inverse && source && cloth && uv) || head < 0) {
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
    const bands = new Map<number, number>()
    let halfWidth = 0
    for (let vertex = 0; vertex < 1120; vertex++) {
      sample.set(...cloth.getElement<[number, number, number]>(vertex, [0, 0, 0]))
      headLocal.transformPoint(sample, point)
      const band = Math.round((uv.getElement(vertex, [0, 0])[1] ?? 0) * 1e5)
      if (Math.abs(point.x) < 0.5 * crown) {
        bands.set(band, Math.max(bands.get(band) ?? 0, -point.z / crown))
      }
      halfWidth = Math.max(halfWidth, Math.abs(point.x) / crown)
    }
    const back = [...bands].sort(([a], [b]) => a - b).map(([, depth]) => depth)
    expect(back).toHaveLength(24)
    expect(halfWidth).toBeLessThan(1.55)
    expect(Math.max(...back.slice(5, 19))).toBeLessThan(0.94)
    // Bands twelve and thirteen straddle the visible flare over the player's belt.
    for (let row = 9; row < 16; row++) {
      expect((back[row + 1] ?? 0) - (back[row] ?? 0)).toBeLessThan(0.11)
    }
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
      for (const { originalRadius, fittedRadius, cuffEdge } of measureSleeveFit(original, before)) {
        expect(originalRadius).toBeGreaterThan(0)
        expect(fittedRadius / originalRadius).toBeLessThan(0.72)
        expect(cuffEdge).toHaveLength(12)
        expect(Math.max(...cuffEdge.map(({ drift }) => drift))).toBeLessThan(0.008)
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
