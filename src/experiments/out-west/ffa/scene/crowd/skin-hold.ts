import { Matrix4, type SkinnedMesh } from 'three'

/**
 * A skinned rider's bone texture only changes when his mixer ticks (30 or 15 Hz), yet three
 * rebuilds and uploads it every frame because the rig moves with him. This keeps the bones in the
 * mesh's own frame instead: the shader's `bindMatrixInverse` is the mesh's world matrix inverted
 * *at the last tick*, so between ticks the model matrix carries everything above the mesh (where
 * he stands, his facing, a roll or a vault) exactly, and the held bone matrices still hold the
 * right pose:
 *
 *   model_now · inverse(model_then) · bones_then = bones_now   (same pose, moved rigidly)
 *
 * three calls `skeleton.update()` once a frame from the render walk, after the world matrices are
 * final (and after `SkinnedMesh.updateMatrixWorld` has reset `bindMatrixInverse`), so that is
 * where the held inverse goes back in. Returns `touch()`: call it on the frames his pose changes;
 * the next draw rebuilds the bones.
 */
export function holdSkin(mesh: SkinnedMesh): () => void {
  const sk = mesh.skeleton
  const update = sk.update.bind(sk)
  const held = new Matrix4()
  let dirty = true
  sk.update = () => {
    if (dirty) {
      dirty = false
      update()
      held.copy(mesh.matrixWorld).invert()
    }
    mesh.bindMatrixInverse.copy(held)
  }
  return () => {
    dirty = true
  }
}
