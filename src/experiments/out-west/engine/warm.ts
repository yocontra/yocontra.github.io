import {
  type Camera,
  type Material,
  Mesh,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three'

export class ProgramWarmError extends Error {
  override name = 'ProgramWarmError'
}

/** Visit actual off-camera casters during loading, then restore the normal culling policy. */
export function warmDrawables(
  scene: Scene,
  shadows: { enabled: boolean; autoUpdate: boolean; needsUpdate: boolean },
  draw: () => void,
): void {
  const meshes: [Mesh, boolean][] = []
  scene.traverse((node) => {
    if (node instanceof Mesh) {
      meshes.push([node, node.frustumCulled])
      node.frustumCulled = false
    }
  })
  const automatic = shadows.autoUpdate
  const pending = shadows.needsUpdate
  try {
    if (shadows.enabled) {
      shadows.needsUpdate = true
    }
    draw()
  } finally {
    for (const [mesh, culled] of meshes) {
      mesh.frustumCulled = culled
    }
    shadows.autoUpdate = automatic
    shadows.needsUpdate = pending
  }
}

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
