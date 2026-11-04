import { type EffectComposer, RenderPass } from 'postprocessing'
import type { Camera, Scene } from 'three'

export interface OverlaySpec {
  scene: Scene
  camera: Camera
  enabled: boolean
}

/**
 * Draw `spec.scene` through `spec.camera` over the main scene, into the same buffer and before the
 * post chain, so it is graded like the rest of the frame: no clear, no background, no shadow-map
 * update. Its depth has to win on its own (Frontier's view model squeezes its depth range into the
 * nearest 1%). `enabled` false skips it at no cost; a null spec removes it. Returns the live pass.
 */
export function applyOverlay(
  composer: EffectComposer,
  current: RenderPass | null,
  spec: OverlaySpec | null,
): RenderPass | null {
  if (!spec) {
    if (current) {
      composer.removePass(current)
      current.dispose()
    }
    return null
  }
  let pass = current
  if (!pass) {
    pass = new RenderPass(spec.scene, spec.camera)
    pass.clear = false
    pass.ignoreBackground = true
    pass.skipShadowMapUpdate = true
    composer.addPass(pass, 1)
  }
  pass.mainScene = spec.scene
  pass.mainCamera = spec.camera
  pass.enabled = spec.enabled
  return pass
}
