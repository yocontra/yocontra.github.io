import type { Camera, Material, Object3D, Scene, WebGLRenderer } from 'three'

/**
 * Compile the programs `override` needs for every drawable in `scene` (except `hidden`), the way
 * `scene.overrideMaterial` would draw them: no fog, to the screen. `gl.compile` only knows each
 * object's own material, so the override is swapped in for the call and swapped back.
 */
export function compileOverride(
  r: { gl: WebGLRenderer; scene: Scene; camera: Camera },
  override: Material,
  hidden: readonly { visible: boolean }[],
): void {
  const { gl, scene } = r
  const skip = new Set<unknown>(hidden)
  const swapped: [Object3D & { material: Material | Material[] }, Material | Material[]][] = []
  scene.traverse((o) => {
    const d = o as Object3D & { material?: Material | Material[] }
    if (d.material && !skip.has(o)) {
      swapped.push([d as Object3D & { material: Material | Material[] }, d.material])
      d.material = override
    }
  })
  const prevFog = scene.fog
  scene.fog = null
  const prevTarget = gl.getRenderTarget()
  gl.setRenderTarget(null)
  gl.compile(scene, r.camera)
  gl.setRenderTarget(prevTarget)
  scene.fog = prevFog
  for (const [o, m] of swapped) {
    o.material = m
  }
}
