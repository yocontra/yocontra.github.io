/** Warm the retained living body's real opaque and hashed programs without changing its state. */
import { type Material, Mesh, type Object3D } from 'three'

export function warmSelfMaterials(holder: Object3D, root: Object3D, warm: () => void): void {
  const parent = holder.parent
  const order = parent?.children.indexOf(holder) ?? -1
  const rootVisible = root.visible
  const nodes: { node: Object3D; visible: boolean; culled: boolean; caster: boolean }[] = []
  const materials = new Map<Material, { hash: boolean; opacity: number; visible: boolean }>()
  holder.traverse((node) => {
    nodes.push({ node, visible: node.visible, culled: node.frustumCulled, caster: node.castShadow })
    if (node instanceof Mesh) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.set(material, {
          hash: material.alphaHash,
          opacity: material.opacity,
          visible: material.visible,
        })
      }
    }
  })
  try {
    root.add(holder)
    root.visible = true
    for (const { node } of nodes) {
      node.visible = true
      node.frustumCulled = false
      node.castShadow = true
    }
    for (const hash of [false, true]) {
      for (const material of materials.keys()) {
        material.visible = true
        material.opacity = 1
        setHash(material, hash)
      }
      warm()
    }
  } finally {
    for (const [material, state] of materials) {
      material.visible = state.visible
      material.opacity = state.opacity
      setHash(material, state.hash)
    }
    for (const { node, visible, culled, caster } of nodes) {
      node.visible = visible
      node.frustumCulled = culled
      node.castShadow = caster
    }
    root.visible = rootVisible
    holder.removeFromParent()
    if (parent) {
      parent.add(holder)
      parent.children.splice(parent.children.indexOf(holder), 1)
      parent.children.splice(order, 0, holder)
    }
  }
}

function setHash(material: Material, hash: boolean): void {
  if (material.alphaHash !== hash) {
    material.alphaHash = hash
    material.needsUpdate = true
  }
}
