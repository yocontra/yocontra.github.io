/** Repair authored face orientation without moving geometry, UVs or morph vertices. */
import type { Accessor, Document, Primitive } from '@gltf-transform/core'

export function repairFrontierWinding(document: Document) {
  return document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) =>
      mesh.listPrimitives().flatMap((primitive) => {
        const material = primitive.getMaterial()
        if (material?.getName() !== 'flora' || material.getDoubleSided()) {
          return []
        }
        const triangles = repairPrimitive(primitive)
        if (triangles === 0) {
          return []
        }
        const node = document
          .getRoot()
          .listNodes()
          .find((candidate) => candidate.getMesh() === mesh)
        return [
          { mesh: node?.getName() ?? mesh.getName(), material: material.getName(), triangles },
        ]
      }),
    )
}

function repairPrimitive(primitive: Primitive): number {
  const positions = primitive.getAttribute('POSITION')
  const normals = primitive.getAttribute('NORMAL')
  const indices = primitive.getIndices()
  const original = indices?.getArray()
  if (!(positions && normals && indices && original)) {
    return 0
  }
  const next = original.slice()
  const keys: string[] = []
  const occurrences = new Map<string, number>()
  for (let index = 0; index < next.length; index += 3) {
    const key = [next[index] ?? 0, next[index + 1] ?? 0, next[index + 2] ?? 0]
      .map((vertex) => positions.getElement(vertex, []).join(','))
      .sort((a, b) => a.localeCompare(b))
      .join('|')
    keys.push(key)
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
  }
  let triangles = 0
  for (let index = 0; index < next.length; index += 3) {
    // Keep deliberate coincident front/back leaf faces; neither requires a culling repair.
    if ((occurrences.get(keys[index / 3] ?? '') ?? 0) > 1) {
      continue
    }
    const vertices = [next[index] ?? 0, next[index + 1] ?? 0, next[index + 2] ?? 0]
    if (againstNormals(positions, normals, vertices)) {
      next[index + 1] = vertices[2] ?? 0
      next[index + 2] = vertices[1] ?? 0
      triangles++
    }
  }
  if (triangles > 0) {
    primitive.setIndices(indices.clone().setArray(next))
  }
  return triangles
}

function againstNormals(
  positions: Accessor,
  normals: Accessor,
  vertices: readonly number[],
): boolean {
  const [a = [], b = [], c = []] = vertices.map((vertex) => positions.getElement(vertex, []))
  const u = b.map((value, axis) => value - (a[axis] ?? 0))
  const v = c.map((value, axis) => value - (a[axis] ?? 0))
  const face = [
    (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
    (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
    (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
  ]
  const normal = vertices
    .map((vertex) => normals.getElement(vertex, []))
    .reduce((sum, vector) => sum.map((value, axis) => value + (vector[axis] ?? 0)), [0, 0, 0])
  const length = Math.hypot(...face) * Math.hypot(...normal)
  if (length < 1e-12) {
    return false
  }
  const cosine = face.reduce((dot, value, axis) => dot + value * (normal[axis] ?? 0), 0) / length
  return cosine < -0.2
}
