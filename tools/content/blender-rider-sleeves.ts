import type { Document, Primitive, Skin } from '@gltf-transform/core'
import { cloneDocument, compactPrimitive } from '@gltf-transform/functions'

const ARM = /^(?:UpperArm|LowerArm|Wrist|Shoulder)[LR]$/u

/** Keep the camera outside the shirt body while using the actual sculpted sleeves and cuffs. */
function sleeveTriangles(part: Primitive, skin: Skin) {
  const indices = part.getIndices()
  const joints = part.getAttribute('JOINTS_0')
  const weights = part.getAttribute('WEIGHTS_0')
  if (!(indices && joints && weights)) {
    throw new Error('Unweighted Blender sleeve')
  }
  const arm = skin.listJoints().map((joint) => ARM.test(joint.getName()))
  const keepVertex = new Uint8Array(joints.getCount())
  for (let v = 0; v < joints.getCount(); v++) {
    const order = joints.getElement(v, [])
    const influence = weights
      .getElement(v, [])
      .reduce((sum, weight, lane) => sum + (arm[order[lane] ?? -1] ? weight : 0), 0)
    keepVertex[v] = Number(influence >= 0.68)
  }
  const kept: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    if (triangle.every((v) => keepVertex[v])) {
      kept.push(...triangle)
    }
  }
  return new Uint32Array(kept)
}

export function cameraSleeves(dressed: Document): Document {
  const arms = cloneDocument(dressed)
  for (const node of arms.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const skin = node.getSkin()
    if (!(skin && mesh)) {
      continue
    }
    for (const part of mesh.listPrimitives()) {
      if (part.getMaterial()?.getName() !== 'Broken-in indigo denim') {
        mesh.removePrimitive(part)
        continue
      }
      const indices = sleeveTriangles(part, skin)
      if (indices.length === 0) {
        mesh.removePrimitive(part)
        continue
      }
      part.setIndices(
        arms
          .createAccessor('Sleeve triangles', arms.getRoot().listBuffers()[0])
          .setType('SCALAR')
          .setArray(indices),
      )
      compactPrimitive(part)
    }
  }
  return arms
}
