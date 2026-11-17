import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Document, Node, Primitive, Skin } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import { integrateGarmentParts } from '../../tools/content/garment-parts.ts'
import stale from '../fixtures/bandana-stale-public.json' with { type: 'json' }
import { io } from './paired-grip-test-helpers.ts'

const MAX_CORNER_ERROR = 0.000_02

/** Independent native skin math, also used for the retained historical triangle. */
function skinPoints(node: Node, primitive: Primitive): Vec3[] {
  const skin = node.getSkin()
  const positions = primitive.getAttribute('POSITION')
  const joints = primitive.getAttribute('JOINTS_0')
  const weights = primitive.getAttribute('WEIGHTS_0')
  const inverseBinds = skin?.getInverseBindMatrices()
  if (!(skin && positions && joints && weights && inverseBinds)) {
    throw new Error('Missing published bandana skin')
  }
  const palette = skin
    .listJoints()
    .map((joint, index) =>
      new Mat4()
        .set(joint.getWorldMatrix())
        .mul(new Mat4().set(inverseBinds.getElement(index, []))),
    )
  return Array.from({ length: positions.getCount() }, (_, index) => {
    const point = new Vec3(...positions.getElement(index, []))
    const ids = joints.getElement(index, [])
    const amounts = weights.getElement(index, [])
    const result = new Vec3()
    for (const [slot, amount] of amounts.entries()) {
      const matrix = palette[ids[slot] ?? -1]
      if (amount) {
        if (!matrix) {
          throw new Error('Invalid published bandana joint')
        }
        result.add(matrix.transformPoint(point, new Vec3()).mulScalar(amount))
      }
    }
    return result
  })
}
function surface(doc: Document): { node: Node; primitive: Primitive } {
  const node = doc
    .getRoot()
    .listNodes()
    .find((candidate) => candidate.getSkin() && candidate.getMesh())
  const primitive = node?.getMesh()?.listPrimitives()[0]
  if (!(node && primitive)) {
    throw new Error('Missing bandana surface')
  }
  return { node, primitive }
}
function cornerKey(point: Vec3): string {
  return point
    .toArray()
    .map((value) => value.toFixed(8))
    .join(',')
}
function triangleKeys(primitive: Primitive, points: Vec3[]): string[] {
  const indices = primitive.getIndices()
  if (!indices) {
    throw new Error('Missing bandana triangles')
  }
  return Array.from({ length: indices.getCount() / 3 }, (_, triangle) =>
    [0, 1, 2]
      .map((corner) => {
        const point = points[indices.getScalar(triangle * 3 + corner)]
        if (!point) {
          throw new Error('Missing bandana corner')
        }
        return cornerKey(point)
      })
      .sort((left, right) => left.localeCompare(right))
      .join('|'),
  ).sort((left, right) => left.localeCompare(right))
}
/** Compare actual skinned corners, independently of weld/index/quantization choices. */
function matchSource(points: Vec3[], source: Vec3[]): Vec3[] {
  return points.map((point) => {
    let nearest: Vec3 | undefined
    let error = Number.POSITIVE_INFINITY
    for (const candidate of source) {
      const distance = candidate.clone().sub(point).length()
      if (distance < error) {
        nearest = candidate
        error = distance
      }
    }
    if (!nearest || error >= MAX_CORNER_ERROR) {
      throw new Error(`Published bandana differs from fitted source: ${error}m`)
    }
    return nearest
  })
}
function uniformDecode(canonical: Skin, published: Skin): { spread: number; affineError: number } {
  const original = canonical.getInverseBindMatrices()
  const encoded = published.getInverseBindMatrices()
  if (!(original && encoded)) {
    throw new Error('Missing bandana inverse binds')
  }
  const decode = (index: number) =>
    new Mat4()
      .set(original.getElement(index, []))
      .invert()
      .mul(new Mat4().set(encoded.getElement(index, [])))
  const common = decode(0).data
  let spread = 0
  for (let index = 0; index < encoded.getCount(); index++) {
    spread = Math.max(
      spread,
      ...Array.from(decode(index).data).map((value, component) =>
        Math.abs(value - (common[component] ?? 0)),
      ),
    )
  }
  // Only stock uniform mesh-position quantization belongs here, never a rig pose.
  const affineError = Math.max(
    ...[1, 2, 3, 4, 6, 7, 8, 9, 11].map((index) => Math.abs(common[index] ?? 0)),
    Math.abs((common[0] ?? 0) - (common[5] ?? 0)),
    Math.abs((common[0] ?? 0) - (common[10] ?? 0)),
    Math.abs((common[15] ?? 0) - 1),
  )
  return { spread, affineError }
}

for (const historical of stale.models) {
  it(`${historical.id} publishes the fitted band, preserves the rig, and rejects the stale public geometry`, async () => {
    const source = await io.read(`tools/art/characters/${historical.id}.gltf`)
    // Reuse the standard portable integration; do not repeat authoring or the native baker.
    await integrateGarmentParts(source, historical.id)
    const authored = surface(source)
    const published = await io.read(
      `public/experiments/out-west/3d/native-v2/equipment/${historical.id}.glb`,
    )
    const compiled = surface(published)
    const sourceSkin = authored.node.getSkin()
    const compiledSkin = compiled.node.getSkin()
    if (!(sourceSkin && compiledSkin)) {
      throw new Error('Missing bandana rig')
    }
    expect(compiledSkin.listJoints().map((joint) => joint.getName())).toEqual(
      sourceSkin.listJoints().map((joint) => joint.getName()),
    )
    expect(compiledSkin.getInverseBindMatrices()?.getCount()).toBe(50)
    const decode = uniformDecode(sourceSkin, compiledSkin)
    expect(decode.spread).toBeLessThan(0.000_002)
    expect(decode.affineError).toBeLessThan(0.000_002)
    // Keep the real old public node/sockets/rig pose, without keeping large historical assets.
    const nodes = published
      .getRoot()
      .listNodes()
      .map((node) => [
        node.getName(),
        node.getParentNode()?.getName(),
        node.getTranslation(),
        node.getRotation(),
        node.getScale(),
        node.getExtras(),
      ])
    expect(createHash('sha256').update(JSON.stringify(nodes)).digest('hex')).toBe(
      historical.nodeSignature,
    )
    expect(published.getRoot().listAnimations()).toHaveLength(0)
    const sourcePoints = skinPoints(authored.node, authored.primitive)
    const compiledPoints = skinPoints(compiled.node, compiled.primitive)
    const activeSource = [...new Set(authored.primitive.getIndices()?.getArray() ?? [])].map(
      (index) => {
        const point = sourcePoints[index]
        if (!point) {
          throw new Error('Missing active fitted corner')
        }
        return point
      },
    )
    expect(compiled.primitive.getIndices()?.getCount()).toBe(1008)
    expect(triangleKeys(compiled.primitive, matchSource(compiledPoints, activeSource))).toEqual(
      triangleKeys(authored.primitive, sourcePoints),
    )
    const oldPoints = historical.decodedWorldCorners.map((point) => new Vec3(...point))
    const oldError = Math.min(
      ...activeSource.map((point) =>
        point
          .clone()
          .sub(oldPoints[0] ?? new Vec3())
          .length(),
      ),
    )
    expect(oldError).toBeGreaterThan(0.001_04)
    expect(oldError).toBeLessThan(0.001_05)
    expect(() => matchSource(oldPoints, activeSource)).toThrow('differs from fitted source')
  })
}
