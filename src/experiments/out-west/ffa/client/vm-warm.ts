import { type Material, Mesh, type Object3D } from 'three'

/** Reflect all real hand and weapon programs, including weapons currently holstered. */
export function warmViewModel(root: Object3D, warm: () => void): void {
  const nodes: [Object3D, boolean, boolean][] = []
  const materials = new Map<Material, boolean>()
  root.traverse((node) => {
    nodes.push([node, node.visible, node.frustumCulled])
    node.visible = true
    node.frustumCulled = false
    if (node instanceof Mesh) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!materials.has(material)) {
          materials.set(material, material.visible)
        }
        material.visible = true
      }
    }
  })
  try {
    warm()
  } finally {
    for (const [node, visible, culled] of nodes) {
      node.visible = visible
      node.frustumCulled = culled
    }
    for (const [material, visible] of materials) {
      material.visible = visible
    }
  }
}
