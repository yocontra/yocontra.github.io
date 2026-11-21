import { expect, test as it } from 'bun:test'
import type { Node, Primitive } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import { io } from './paired-grip-test-helpers.ts'

const ktx2 = /\.ktx2$/u

function bindOf(node: Node, name: string): Mat4 {
  const skin = node.getSkin()
  const index = skin?.listJoints().findIndex((joint) => joint.getName() === name) ?? -1
  const matrices = skin?.getInverseBindMatrices()
  if (!matrices || index < 0) {
    throw new Error(`Missing ${name} inverse bind`)
  }
  return new Mat4().set(matrices.getElement(index, []))
}

function vertices(node: Node, primitive: Primitive, matrix: Mat4): Vec3[] {
  const position = primitive.getAttribute('POSITION')
  const indices = primitive.getIndices()
  if (!(position && indices)) {
    throw new Error(`Missing indexed surface ${node.getName()}`)
  }
  return Array.from(indices.getArray() ?? [], (i) =>
    matrix.transformPoint(new Vec3(...position.getElement(i, []))),
  )
}

for (const [name, artwork, bones] of [
  ['tin-star', 'tin-star', ['Chest']],
  ['red-bandana', 'bandana', ['Chest', 'Neck']],
  ['black-bandana', 'bandana', ['Chest', 'Neck']],
  ['handlebar', 'handlebar', ['Head']],
] as const) {
  it(`${name} publishes the new surface on the original rig`, async () => {
    const id = `extra.${name}`
    const [art, rig, model] = await Promise.all([
      io.read(`tools/art/characters/accessories/${artwork}.glb`),
      io.read(`tools/art/characters/${id}.gltf`),
      io.read(`public/experiments/out-west/3d/native-v2/equipment/${id}.glb`),
    ])
    const original = rig
      .getRoot()
      .listNodes()
      .find((node) => node.getMesh() && node.getSkin())
    const compiled = model
      .getRoot()
      .listNodes()
      .find((node) => node.getMesh() && node.getSkin())
    const surface = compiled?.getMesh()?.listPrimitives()[0]
    const joints = surface?.getAttribute('JOINTS_0')
    const weights = surface?.getAttribute('WEIGHTS_0')
    const uv = surface?.getAttribute('TEXCOORD_0')
    if (!(original && compiled && surface && joints && weights && uv)) {
      throw new Error(`Missing fitted surface for ${id}`)
    }

    const packedToOriginal = bindOf(original, 'Hips').invert().mul(bindOf(compiled, 'Hips'))
    const authored = art
      .getRoot()
      .listNodes()
      .flatMap((node) => {
        const toOriginal = new Mat4().set(node.getWorldMatrix())
        return (node.getMesh()?.listPrimitives() ?? []).flatMap((part) =>
          vertices(node, part, toOriginal),
        )
      })
    const published = vertices(compiled, surface, packedToOriginal)
    expect(published).toHaveLength(authored.length)
    const largestError = published.reduce((error, point, i) => {
      const originalPoint = authored[i]
      return originalPoint
        ? Math.max(error, point.distance(originalPoint))
        : Number.POSITIVE_INFINITY
    }, 0)
    expect(largestError).toBeLessThan(0.000_002)

    const names =
      compiled
        .getSkin()
        ?.listJoints()
        .map((joint) => joint.getName()) ?? []
    expect(names).toEqual(
      original
        .getSkin()
        ?.listJoints()
        .map((joint) => joint.getName()) ?? [],
    )
    const active = new Set<string>()
    for (let index = 0; index < joints.getCount(); index++) {
      const ids = joints.getElement(index, [])
      const amounts = weights.getElement(index, [])
      expect(amounts.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 6)
      for (const [slot, amount] of amounts.entries()) {
        if (amount > 0) {
          active.add(names[ids[slot] ?? -1] ?? '')
        }
      }
    }
    expect(active).toEqual(new Set(bones))
    expect(uv.getMinNormalized([]).every((value) => value >= 0)).toBe(true)
    expect(uv.getMaxNormalized([]).every((value) => value <= 1)).toBe(true)
    const maps = surface.getMaterial()?.getExtras().nativePbr as Record<string, unknown>
    for (const channel of ['albedo', 'normal', 'arm']) {
      expect(maps[channel]).toMatch(ktx2)
    }
  })
}
