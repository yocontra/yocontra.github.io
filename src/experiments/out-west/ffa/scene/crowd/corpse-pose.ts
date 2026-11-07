/** Update physical bone frames parent-first, then visit fingers, clothing and gear once. */
import { type Bone, type Group, Matrix4, type Object3D, Quaternion, Vector3 } from 'three'
import type { CorpsePose } from './corpse-rig.ts'

export function corpsePose(root: Group, bones: Bone[]) {
  const indices = new Map(bones.map((bone, index) => [bone, index]))
  const ancestors = new Set<Object3D>()
  for (const bone of bones) {
    for (let node: Object3D | null = bone; node && node !== root; node = node.parent) {
      ancestors.add(node)
    }
  }
  const path: { node: Object3D; index: number | undefined }[] = []
  root.traverse((node) => {
    if (ancestors.has(node)) {
      path.push({ node, index: indices.get(node as Bone) })
    }
  })
  const rotation = new Quaternion()
  const position = new Vector3()
  const scale = new Vector3()
  const inverse = new Matrix4()
  return (poses: readonly CorpsePose[]): void => {
    root.updateWorldMatrix(true, false)
    for (const { node, index } of path) {
      const target = index === undefined ? undefined : poses[index]
      if (target) {
        node.position.copy(target.position)
        if (node.parent) {
          node.position.applyMatrix4(inverse.copy(node.parent.matrixWorld).invert())
        }
        rotation.identity()
        node.parent?.matrixWorld.decompose(position, rotation, scale)
        node.quaternion.copy(rotation.invert().multiply(target.rotation))
      }
      node.updateWorldMatrix(false, false)
    }
    // SkinnedMesh.updateMatrixWorld also refreshes its attached inverse-bind transform.
    root.updateMatrixWorld(true)
  }
}
