/** Exact necessary-condition culling for immutable cosmetic-world triangle meshes. */
import type { AABB, Trimesh } from 'cannon-es'

const stats = new WeakMap<Trimesh, { queries: number; candidates: number; accepted: number }>()
export const meshCullingStats = (mesh: Trimesh) => stats.get(mesh)

export function refineStaticMesh(mesh: Trimesh): void {
  const bounds = new Float64Array(mesh.indices.length * 2)
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle++) {
    for (let axis = 0; axis < 3; axis++) {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (let corner = 0; corner < 3; corner++) {
        const index = mesh.indices[triangle * 3 + corner] ?? 0
        const value = mesh.vertices[index * 3 + axis] ?? 0
        lo = Math.min(lo, value)
        hi = Math.max(hi, value)
      }
      bounds[triangle * 6 + axis] = lo
      bounds[triangle * 6 + axis + 3] = hi
    }
  }
  const counters = { queries: 0, candidates: 0, accepted: 0 }
  stats.set(mesh, counters)
  const overlaps = (triangle: number, query: AABB) => {
    const offset = triangle * 6
    return (
      (bounds[offset] ?? 0) <= query.upperBound.x &&
      (bounds[offset + 3] ?? 0) >= query.lowerBound.x &&
      (bounds[offset + 1] ?? 0) <= query.upperBound.y &&
      (bounds[offset + 4] ?? 0) >= query.lowerBound.y &&
      (bounds[offset + 2] ?? 0) <= query.upperBound.z &&
      (bounds[offset + 5] ?? 0) >= query.lowerBound.z
    )
  }
  type Node = Trimesh['tree']['children'][number]
  const stack: Node[] = []
  mesh.tree.aabbQuery = (query, result) => {
    counters.queries++
    stack.length = 0
    stack.push(mesh.tree)
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node?.aabb.overlaps(query)) {
        continue
      }
      for (const triangle of node.data) {
        counters.candidates++
        if (overlaps(triangle, query)) {
          result.push(triangle)
          counters.accepted++
        }
      }
      // Preserve Cannon's original traversal/triangle order, including touching AABB faces.
      stack.push(...node.children)
    }
    return result
  }
}
