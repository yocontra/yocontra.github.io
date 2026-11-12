import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Quat, Vec3 } from 'playcanvas'
import { authorTumbleweedRolling } from '../../tools/content/frontier-authoring.ts'

const source = 'tools/art/environments/frontier-tumbleweeds.glb'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const hash = (values: ArrayLike<number> | null) =>
  createHash('sha256')
    .update(JSON.stringify(Array.from(values ?? [])))
    .digest('hex')
const quaternion = (values: number[]) =>
  new Quat(values[0], values[1], values[2], values[3]).normalize()
const angle = (rotation: Quat) =>
  2 * Math.atan2(Math.hypot(rotation.x, rotation.y, rotation.z), Math.abs(rotation.w))
const difference = (a: Quat, b: Quat) => angle(new Quat().mul2(a, b.clone().invert()).normalize())

it('preserves authored paths, timing, geometry and resources while baking rotation only', async () => {
  const doc = await io.read(source)
  const root = doc.getRoot()
  const retained = () => ({
    channels: root.listAnimations().flatMap((animation) =>
      animation.listChannels().map((channel) => ({
        node: channel.getTargetNode()?.getName(),
        path: channel.getTargetPath(),
        interpolation: channel.getSampler()?.getInterpolation(),
        input: hash(channel.getSampler()?.getInput()?.getArray() ?? null),
        outputCount: channel.getSampler()?.getOutput()?.getCount(),
        movement:
          channel.getTargetPath() === 'rotation'
            ? null
            : hash(channel.getSampler()?.getOutput()?.getArray() ?? null),
      })),
    ),
    geometry: root.listMeshes().map((mesh) =>
      mesh.listPrimitives().map((primitive) => ({
        indices: hash(primitive.getIndices()?.getArray() ?? null),
        attributes: primitive
          .listSemantics()
          .map((semantic) => [
            semantic,
            hash(primitive.getAttribute(semantic)?.getArray() ?? null),
          ]),
      })),
    ),
    materials: root.listMaterials().map((material) => material.getName()),
    textures: root.listTextures().map((texture) => hash(texture.getImage())),
  })
  const before = retained()
  authorTumbleweedRolling(doc)
  expect(retained()).toEqual(before)
})

it('rolls along both X and Z with bounded slip and a continuous native loop', async () => {
  const doc = await io.read(source)
  authorTumbleweedRolling(doc)
  let maximumSlip = 0
  let zDominant = 0
  let minimumZRoll = Number.POSITIVE_INFINITY
  for (const animation of doc.getRoot().listAnimations()) {
    for (const channel of animation
      .listChannels()
      .filter((candidate) => candidate.getTargetPath() === 'rotation')) {
      const rotations = channel.getSampler()?.getOutput()
      const movement = animation
        .listChannels()
        .find(
          (candidate) =>
            candidate.getTargetNode() === channel.getTargetNode() &&
            candidate.getTargetPath() === 'translation',
        )
        ?.getSampler()
      const positions = movement?.getOutput()
      if (!(rotations && movement && positions)) {
        throw new Error('Missing native tumbleweed motion')
      }
      const radius = positions.getElement(0, [])[1] ?? 0
      expect(rotations.getCount()).toBe(1344)
      expect(movement.getInput()?.getScalar(rotations.getCount() - 1)).toBeCloseTo(67.105, 2)
      const first = quaternion(rotations.getElement(0, []))
      const last = quaternion(rotations.getElement(rotations.getCount() - 1, []))
      expect(difference(first, last)).toBeLessThan(0.000_001)
      for (let frame = 1; frame < rotations.getCount(); frame++) {
        const a = positions.getElement(frame - 1, [])
        const b = positions.getElement(frame, [])
        const dx = (b[0] ?? 0) - (a[0] ?? 0)
        const dz = (b[2] ?? 0) - (a[2] ?? 0)
        const distance = Math.hypot(dx, dz)
        const before = quaternion(rotations.getElement(frame - 1, []))
        const after = quaternion(rotations.getElement(frame, []))
        expect(
          before.x * after.x + before.y * after.y + before.z * after.z + before.w * after.w,
        ).toBeGreaterThan(0)
        if (distance === 0) {
          continue
        }
        const expected = new Quat().setFromAxisAngle(
          new Vec3(dz / distance, 0, -dx / distance),
          (distance / radius) * (180 / Math.PI),
        )
        const actual = new Quat().mul2(after, before.clone().invert()).normalize()
        const slip = difference(expected, actual) / (distance / radius)
        maximumSlip = Math.max(maximumSlip, slip)
        if (Math.abs(dz) > Math.abs(dx) * 10) {
          zDominant++
          minimumZRoll = Math.min(minimumZRoll, angle(actual) / (distance / radius))
        }
      }
    }
  }
  expect(zDominant).toBeGreaterThan(0)
  expect(minimumZRoll).toBeGreaterThan(0.92)
  expect(maximumSlip).toBeLessThan(0.075)
})
