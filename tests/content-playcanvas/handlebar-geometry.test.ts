import { expect, test as it } from 'bun:test'
import type { Node, Primitive } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import { integrateGarmentParts } from '../../tools/content/garment-parts.ts'
import { io } from './paired-grip-test-helpers.ts'

const IDS = ['extra.handlebar', 'outlaw-5', 'outlaw-16']
function body(doc: Awaited<ReturnType<typeof io.read>>): Node {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'Character' && n.getSkin())
  if (!node) {
    throw new Error('Missing canonical facial-hair rig')
  }
  return node
}
function primitive(node: Node): Primitive {
  const surface = node.getMesh()?.listPrimitives()[0]
  if (!surface) {
    throw new Error('Missing facial-hair surface')
  }
  return surface
}
function key(point: number[]): string {
  return point.map((value) => value.toFixed(7)).join(',')
}
function closed(surface: Primitive): boolean {
  const indices = surface.getIndices()
  const position = surface.getAttribute('POSITION')
  if (!(indices && position)) {
    throw new Error('Missing moustache triangles')
  }
  const edges = new Map<string, number>()
  for (let i = 0; i < indices.getCount(); i += 3) {
    const corners = [0, 1, 2].map((k) => key(position.getElement(indices.getScalar(i + k), [])))
    for (let k = 0; k < 3; k++) {
      const edge = [corners[k] ?? '', corners[(k + 1) % 3] ?? '']
        .sort((left, right) => left.localeCompare(right))
        .join('|')
      edges.set(edge, (edges.get(edge) ?? 0) + 1)
    }
  }
  return [...edges.values()].every((count) => count === 2)
}
function headPoints(node: Node, surface: Primitive): Vec3[] {
  const skin = node.getSkin()
  const matrix = skin?.getInverseBindMatrices()
  const position = surface.getAttribute('POSITION')
  const head = skin?.listJoints().findIndex((joint) => joint.getName() === 'Head')
  if (!(matrix && position && head !== undefined && head >= 0)) {
    throw new Error('Missing Head bind')
  }
  const bind = new Mat4().set(matrix.getElement(head, []))
  return Array.from({ length: position.getCount() }, (_, i) =>
    bind.transformPoint(new Vec3(...position.getElement(i, [] as number[]))),
  )
}

for (const id of IDS) {
  it(`${id} replaces only the 46 moustache faces with a closed Head-skinned curl`, async () => {
    const source = await io.read(`tools/art/characters/${id}.gltf`)
    const node = body(source)
    const original = primitive(node)
    const authored = await io.read(`tools/art/characters/facial-hair/${id}.glb`)
    await validateAuthoringInputs(authored)
    const surface = authored.getRoot().listMeshes()[0]?.listPrimitives()[0]
    if (!surface) {
      throw new Error('Missing authored moustache')
    }
    const metadata = authored.getRoot().getExtras() as {
      removeTriangles: number[]
      replaceRanges: unknown[]
      handlebarFit: { preservedGoateeTriangles: number; headTopology: number }
    }
    expect(metadata.removeTriangles).toHaveLength(46)
    expect(metadata.replaceRanges).toEqual([])
    expect(metadata.handlebarFit.headTopology).toBe(1555)
    expect(metadata.handlebarFit.preservedGoateeTriangles).toBe(id === 'outlaw-16' ? 136 : 0)
    expect(surface.getIndices()?.getCount()).toBe(11_856)
    expect(closed(surface)).toBe(true)
    const head = node
      .getSkin()
      ?.listJoints()
      .findIndex((joint) => joint.getName() === 'Head')
    const joints = surface.getAttribute('_AUTHOR_JOINTS')
    const weights = surface.getAttribute('_AUTHOR_WEIGHTS')
    if (!(joints && weights && head !== undefined && head >= 0)) {
      throw new Error('Missing authored Head influences')
    }
    for (let i = 0; i < joints.getCount(); i++) {
      expect(joints.getElement(i, [] as number[])).toEqual([head, 0, 0, 0])
      expect(weights.getElement(i, [] as number[])).toEqual([1, 0, 0, 0])
    }
    const streams = original
      .listSemantics()
      .map((name) => [name, Array.from(original.getAttribute(name)?.getArray() ?? [])] as const)
    const originalIndices = Array.from(original.getIndices()?.getArray() ?? [])
    const beard = (
      node.getExtras().pieceRanges as { name?: string; start: number; count: number }[]
    ).find((range) => range.name === 'Beard')
    if (!beard) {
      throw new Error('Missing canonical beard boundary')
    }
    const keep: string[] = []
    for (let triangle = 0; triangle < originalIndices.length / 3; triangle++) {
      const face = originalIndices.slice(triangle * 3, triangle * 3 + 3)
      if (
        !metadata.removeTriangles.includes(triangle) &&
        face.every((index) => index >= beard.start && index < beard.start + beard.count)
      ) {
        keep.push(face.join(','))
      }
    }
    expect(keep).toHaveLength(id === 'outlaw-16' ? 136 : 0)
    await integrateGarmentParts(source, id)
    const indices = original.getIndices()
    if (!indices) {
      throw new Error('Missing integrated facial hair')
    }
    const remaining = new Set(
      Array.from({ length: indices.getCount() / 3 }, (_, triangle) =>
        [0, 1, 2].map((corner) => indices.getScalar(triangle * 3 + corner)).join(','),
      ),
    )
    expect(keep.every((face) => remaining.has(face))).toBe(true)
    expect(
      metadata.removeTriangles.every(
        (triangle) =>
          !remaining.has(originalIndices.slice(triangle * 3, triangle * 3 + 3).join(',')),
      ),
    ).toBe(true)
    for (const [name, values] of streams) {
      expect(
        Array.from(original.getAttribute(name)?.getArray() ?? []).slice(0, values.length),
      ).toEqual(values)
    }
  })
}
for (const id of [...IDS, 'outlaw-5.pair', 'outlaw-16.pair']) {
  it(`${id} publishes the actual fitted moustache with its native PBR maps`, async () => {
    const sourceId = id.replace('.pair', '')
    const source = await io.read(`tools/art/characters/${sourceId}.gltf`)
    const sourceNode = body(source)
    const authored = await io.read(`tools/art/characters/facial-hair/${sourceId}.glb`)
    const sourceSurface = authored.getRoot().listMeshes()[0]?.listPrimitives()[0]
    if (!sourceSurface) {
      throw new Error('Missing fitted source')
    }
    const expected = [
      ...new Map(headPoints(sourceNode, sourceSurface).map((p) => [key(p.toArray()), p])).values(),
    ]
    const category = id.startsWith('extra.') ? 'equipment' : 'baked'
    const published = await io.read(
      `public/experiments/out-west/3d/native-v2/${category}/${id}.glb`,
    )
    const hair = published
      .getRoot()
      .listNodes()
      .flatMap((node) =>
        (node.getMesh()?.listPrimitives() ?? [])
          .filter((p) => p.getMaterial()?.getName() === 'handlebar-hair')
          .map((surface) => ({ node, surface })),
      )
    expect(hair).toHaveLength(1)
    for (const { node, surface } of hair) {
      expect(surface.getIndices()?.getCount()).toBe(11_856)
      const material = surface.getMaterial()?.getExtras().nativePbr as {
        albedo: string
        normal: string
        arm: string
      }
      expect(
        [material.albedo, material.normal, material.arm].every((url) => url.endsWith('.ktx2')),
      ).toBe(true)
      const head = node
        .getSkin()
        ?.listJoints()
        .findIndex((joint) => joint.getName() === 'Head')
      const joints = surface.getAttribute('JOINTS_0')
      const weights = surface.getAttribute('WEIGHTS_0')
      if (!(joints && weights && head !== undefined && head >= 0)) {
        throw new Error('Missing published hair influences')
      }
      for (let i = 0; i < joints.getCount(); i++) {
        expect(joints.getElement(i, [] as number[])).toEqual([head, 0, 0, 0])
        expect(weights.getElement(i, [] as number[])).toEqual([1, 0, 0, 0])
      }
      // Decode the stock mesh quantization in the native Head bind before matching.
      for (const point of headPoints(node, surface)) {
        expect(Math.min(...expected.map((p) => p.clone().sub(point).length()))).toBeLessThan(0.0002)
      }
    }
  })
}
