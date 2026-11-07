/** Current camera frustum; physics continues for every corpse when floor poses are offscreen. */
import { type Camera, Frustum, Matrix4, Vector3 } from 'three'
import type { CorpsePhysics } from './ragdoll-body.ts'

export interface CorpseView {
  frustum: Frustum
  skipOffscreenPose: boolean
  position?: Vector3
}

export class CorpsePresentation {
  readonly view: CorpseView = { frustum: new Frustum(), skipOffscreenPose: false }
  private readonly matrix = new Matrix4()
  private readonly state = { ready: false }

  get ready(): boolean {
    return this.state.ready
  }

  update(camera: Camera, skipOffscreenPose: boolean, corpses: readonly CorpsePhysics[]): void {
    camera.updateMatrixWorld()
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.view.frustum.setFromProjectionMatrix(this.matrix)
    this.view.skipOffscreenPose = skipOffscreenPose
    this.view.position ??= new Vector3()
    camera.getWorldPosition(this.view.position)
    this.state.ready = true
    for (const corpse of corpses) {
      corpse.present(this.view)
    }
  }
}
