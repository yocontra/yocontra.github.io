/** Independent decoded-cell check for the two deliberately moved NPC15 donors. */
import type { Node, Primitive } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'

export function throatValue<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error('Missing throat audit value')
  }
  return value
}
interface QuantizedDonor {
  id: string
  sourceVertex: number
  node: Node
  primitive: Primitive
  vertex: number
  expectedHead: Vec3
}
export function assertNPC15QuantizedDonor(options: QuantizedDonor): number {
  const { id, sourceVertex, node, primitive, vertex, expectedHead } = options
  if (id !== 'outlaw-15' || ![83, 84].includes(sourceVertex)) {
    throw new Error('No other POSITION exception is owned')
  }
  const position = throatValue(primitive.getAttribute('POSITION'))
  const skin = throatValue(node.getSkin())
  const inverseBind = throatValue(skin.getInverseBindMatrices())
  const head = skin.listJoints().findIndex((joint) => joint.getName() === 'Head')
  const storage = position.getArray()
  if (
    head < 0 ||
    position.getComponentType() !== 5122 ||
    !position.getNormalized() ||
    !(storage instanceof Int16Array)
  ) {
    throw new Error('Expected stock signed14-bit POSITION storage and Head bind')
  }
  const bind = new Mat4().set(inverseBind.getElement(head, []))
  const expected = bind.clone().invert().transformPoint(expectedHead).toArray()
  const actual = position.getElement(vertex, [])
  // Stock quantize({cleanup:false}) uses13 magnitude bits, replicated into signed16.
  // Check the pre-affine quantization cell; no other donor or raw rig guard changes.
  for (let axis = 0; axis < 3; axis++) {
    const raw = throatValue(storage[vertex * 3 + axis])
    const magnitude = Math.abs(raw)
    const bucket = magnitude >> 2
    if (magnitude !== ((bucket << 2) | (bucket >> 11))) {
      throw new Error('Stock14-bit replicated grid changed')
    }
    const value = throatValue(expected[axis])
    throatValue(actual[axis])
    const signedMagnitude = Math.abs(value)
    const tolerance = 3e-7 // Float32 source/native affine storage, not a cell allowance.
    if (
      Math.abs(value) > 1 + tolerance ||
      (bucket !== 0 && Math.sign(raw) !== Math.sign(value)) ||
      signedMagnitude < Math.max(0, (bucket - 0.5) / 8191) - tolerance ||
      signedMagnitude > Math.min(1, (bucket + 0.5) / 8191) + tolerance
    ) {
      throw new Error('Decoded stock quantization cell does not contain the exact authored donor')
    }
  }
  return bind.transformPoint(new Vec3(...actual)).distance(expectedHead)
}
