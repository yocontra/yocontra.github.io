/** Native glTF packing that leaves positions, UVs, morph movement and animation timing exact. */
import { createHash } from 'node:crypto'
import type { Accessor, Document } from '@gltf-transform/core'
import { quantize } from '@gltf-transform/functions'

const PACKED_ATTRIBUTES = /^(?:NORMAL|TANGENT|COLOR_0)$/u

function geometryDigest(doc: Document) {
  const hash = createHash('sha256')
  const attribute = (accessor: Accessor | null) => {
    const data = accessor?.getArray()
    if (data) {
      hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
  }
  for (const node of doc.getRoot().listNodes()) {
    hash.update(JSON.stringify([node.getName(), node.getWorldMatrix()]))
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      for (const key of ['POSITION', 'TEXCOORD_0', 'TEXCOORD_1']) {
        attribute(primitive.getAttribute(key))
      }
      attribute(primitive.getIndices())
      for (const target of primitive.listTargets()) {
        attribute(target.getAttribute('POSITION'))
      }
    }
  }
  for (const clip of doc.getRoot().listAnimations()) {
    hash.update(clip.getName())
    for (const sampler of clip.listSamplers()) {
      attribute(sampler.getInput())
      attribute(sampler.getOutput())
      hash.update(sampler.getInterpolation())
    }
    for (const channel of clip.listChannels()) {
      hash.update(JSON.stringify([channel.getTargetNode()?.getName(), channel.getTargetPath()]))
    }
  }
  return hash.digest('hex')
}

export async function packFrontierVertices(doc: Document) {
  const geometry = geometryDigest(doc)
  const originals = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) =>
      mesh.listPrimitives().map((primitive) => ({
        primitive,
        normals: Array.from(primitive.getAttribute('NORMAL')?.getArray() ?? []),
        tangents: Array.from(primitive.getAttribute('TANGENT')?.getArray() ?? []),
      })),
    )
  await doc.transform(
    quantize({ pattern: PACKED_ATTRIBUTES, quantizeNormal: 16, quantizeColor: 8 }),
  )
  if (geometryDigest(doc) !== geometry) {
    throw new Error('Frontier vertex packing changed geometry, UVs, wind or timing')
  }
  let maximumNormalAngle = 0
  let maximumTangentAngle = 0
  for (const original of originals) {
    for (const [semantic, values, stride] of [
      ['NORMAL', original.normals, 3],
      ['TANGENT', original.tangents, 4],
    ] as const) {
      const attribute = original.primitive.getAttribute(semantic)
      if (!attribute) {
        continue
      }
      for (let index = 0; index < attribute.getCount(); index++) {
        const after = attribute.getElement(index, []).slice(0, 3)
        const before = values.slice(index * stride, index * stride + 3)
        const length = Math.hypot(...after) * Math.hypot(...before)
        if (length === 0) {
          continue
        }
        const dot =
          after.reduce((total, value, axis) => total + value * (before[axis] ?? 0), 0) / length
        const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
        if (semantic === 'NORMAL') {
          maximumNormalAngle = Math.max(maximumNormalAngle, angle)
        } else {
          maximumTangentAngle = Math.max(maximumTangentAngle, angle)
        }
      }
    }
  }
  return { geometry, maximumNormalAngle, maximumTangentAngle }
}
