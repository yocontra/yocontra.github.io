/**
 * One shadow-depth material per KIND of caster. three.js renders every caster without a
 * `customDepthMaterial` through one shared MeshDepthMaterial, so a shadow pass that walks
 * skinned riders, instanced props and plain meshes in scene order flips that material's
 * skinning/instancing program on nearly every draw, and each flip re-resolves the program
 * (`getParameters`, cache-key strings: CPU and garbage, every frame). Giving each kind its own
 * depth material keeps every program stable. Same shader, same output: nothing visual changes.
 */
import { type InstancedMesh, type Mesh, MeshDepthMaterial, type Object3D } from 'three'

const SKINNED = new MeshDepthMaterial()
const INSTANCED = new MeshDepthMaterial()
const INSTANCED_COLOR = new MeshDepthMaterial()

/** Assign the kind's depth material to every shadow caster under `root` that has none yet. */
export function shareDepthByKind(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh & Partial<Pick<InstancedMesh, 'isInstancedMesh' | 'instanceColor'>>
    // biome-ignore lint/suspicious/noUnnecessaryConditions: three types isMesh as `true` on the cast; this is the runtime type check
    if (!(m.isMesh && m.castShadow) || m.customDepthMaterial !== undefined) {
      return
    }
    const mat = m.material
    if (
      Array.isArray(mat) ||
      mat.alphaTest > 0 ||
      (mat as { alphaMap?: unknown }).alphaMap ||
      mat.alphaToCoverage
    ) {
      // cut-outs keep three's per-material depth variant
      return
    }
    if ((m as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
      m.customDepthMaterial = SKINNED
    } else if (m.isInstancedMesh === true) {
      m.customDepthMaterial = m.instanceColor ? INSTANCED_COLOR : INSTANCED
    }
  })
}
