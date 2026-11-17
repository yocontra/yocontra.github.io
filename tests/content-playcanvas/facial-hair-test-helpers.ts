/** Independent geometry/skin references shared by facial-hair source regressions. */
import { createHash } from 'node:crypto'
import type { Document, Node, Primitive } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'

export function body(doc: Document): Node {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'Character' && n.getSkin())
  if (!node) {
    throw new Error('Missing canonical facial-hair rig')
  }
  return node
}
export function primitive(node: Node): Primitive {
  const surface = node.getMesh()?.listPrimitives()[0]
  if (!surface) {
    throw new Error('Missing facial-hair surface')
  }
  return surface
}
export function key(point: number[]): string {
  return point.map((value) => value.toFixed(7)).join(',')
}
export function closed(surface: Primitive): boolean {
  const indices = surface.getIndices()
  const position = surface.getAttribute('POSITION')
  if (!(indices && position)) {
    throw new Error('Missing moustache triangles')
  }
  const edges = new Map<string, number>()
  for (let i = 0; i < indices.getCount(); i += 3) {
    const corners = [0, 1, 2].map((k) => key(position.getElement(indices.getScalar(i + k), [])))
    for (let k = 0; k < 3; k++) {
      const edge = [corners[k] ?? '', corners[(k + 1) % 3] ?? '']
        .sort((left, right) => left.localeCompare(right))
        .join('|')
      edges.set(edge, (edges.get(edge) ?? 0) + 1)
    }
  }
  return [...edges.values()].every((count) => count === 2)
}
export function headPoints(node: Node, surface: Primitive): Vec3[] {
  const skin = node.getSkin()
  const matrix = skin?.getInverseBindMatrices()
  const position = surface.getAttribute('POSITION')
  const head = skin?.listJoints().findIndex((joint) => joint.getName() === 'Head')
  if (!(matrix && position && head !== undefined && head >= 0)) {
    throw new Error('Missing Head bind')
  }
  const bind = new Mat4().set(matrix.getElement(head, []))
  return Array.from({ length: position.getCount() }, (_, i) =>
    bind.transformPoint(new Vec3(...position.getElement(i, [] as number[]))),
  )
}

/** The accepted moustache and the separately authored beard have a clear gap. */
export function hairCorners(node: Node, surface: Primitive, part: 'moustache' | 'beard'): number[] {
  const indices = surface.getIndices()
  if (!indices) {
    throw new Error('Missing hair triangles')
  }
  const points = headPoints(node, surface)
  const selected: number[] = []
  for (let triangle = 0; triangle < indices.getCount(); triangle += 3) {
    const ids = [0, 1, 2].map((corner) => indices.getScalar(triangle + corner))
    const above = ids.map((index) => (points[index]?.y ?? 0) > 0.026)
    if (above.some(Boolean) && !above.every(Boolean)) {
      throw new Error('Hair ownership boundary crossed')
    }
    if (above.every(Boolean) === (part === 'moustache')) {
      selected.push(...ids)
    }
  }
  return selected
}
export function rawCornerSignature(surface: Primitive, corners: number[]): string {
  const semantics = surface.listSemantics().sort((left, right) => left.localeCompare(right))
  const triangles: string[] = []
  for (let t = 0; t < corners.length; t += 3) {
    triangles.push(
      JSON.stringify(
        corners.slice(t, t + 3).map((index) =>
          semantics.map((name) => {
            const attribute = surface.getAttribute(name)
            const values = attribute?.getArray()
            if (!(attribute && values)) {
              throw new Error('Missing published hair attribute')
            }
            const stride = attribute.getElementSize() * values.BYTES_PER_ELEMENT
            const bytes = new Uint8Array(values.buffer, values.byteOffset + index * stride, stride)
            return [
              name,
              attribute.getComponentType(),
              attribute.getNormalized(),
              Buffer.from(bytes).toString('hex'),
            ]
          }),
        ),
      ),
    )
  }
  const ordered = triangles.sort((left, right) => {
    if (left < right) {
      return -1
    }
    if (left > right) {
      return 1
    }
    return 0
  })
  return createHash('sha256').update(ordered.join('\n')).digest('hex')
}

/** A bounded grid compares decoded points without quadratic scans of a dense beard. */
export function fittedErrors(actual: Vec3[], expected: Vec3[], epsilon = 0.0002): number[] {
  const cells = new Map<string, Vec3[]>()
  const cell = (x: number, y: number, z: number) => [x, y, z].join(',')
  for (const point of expected) {
    const cellKey = cell(
      Math.floor(point.x / epsilon),
      Math.floor(point.y / epsilon),
      Math.floor(point.z / epsilon),
    )
    const bucket = cells.get(cellKey) ?? []
    bucket.push(point)
    cells.set(cellKey, bucket)
  }
  return actual.map((point) => {
    const [x = 0, y = 0, z = 0] = point.toArray().map((v) => Math.floor(v / epsilon))
    let distance = Number.POSITIVE_INFINITY
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const p of cells.get(cell(x + dx, y + dy, z + dz)) ?? []) {
            distance = Math.min(distance, Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z))
          }
        }
      }
    }
    return distance
  })
}
