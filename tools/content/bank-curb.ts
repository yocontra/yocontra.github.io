import { resolve } from 'node:path'
import { type Accessor, type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Vec3 } from 'playcanvas'

const MIN_HEIGHT = 0.34
const MAX_HEIGHT = 0.36
const GRID_TOLERANCE = 0.006
const ROAD_EDGE = 9
const SPANS = 10

interface Face {
  offset: number
  corners: string[]
  area: number
}

interface Span {
  pavement: Face[]
  curb: Face[]
  length: number
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < GRID_TOLERANCE
}

function roadFace(vertices: Vec3[], offset: number) {
  const [a, b, c] = vertices
  if (!(a && b && c)) {
    return null
  }
  const edge = Math.sign(a.x) * ROAD_EDGE
  if (!near(a.x, edge) || vertices.some((point) => point.x !== a.x)) {
    return null
  }
  const minY = Math.min(a.y, b.y, c.y)
  const height = Math.max(a.y, b.y, c.y)
  if (!(near(minY, 0) && (near(height, MIN_HEIGHT) || near(height, MAX_HEIGHT)))) {
    return null
  }
  // These faces are two flat rectangular strips per span. Keep the strip that reaches curb height.
  const twiceArea = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y)
  if (Math.sign(twiceArea) !== -Math.sign(edge)) {
    return null
  }
  const minZ = Math.min(a.z, b.z, c.z)
  const maxZ = Math.max(a.z, b.z, c.z)
  if (
    near(minZ, maxZ) ||
    !vertices.every(
      ({ y, z }) => (near(y, 0) || near(y, height)) && (near(z, minZ) || near(z, maxZ)),
    )
  ) {
    return null
  }
  const corners = vertices.map(({ y, z }) => `${near(y, 0) ? 0 : 1}:${near(z, minZ) ? 0 : 1}`)
  return {
    key: `${a.x}:${minY}:${minZ}:${maxZ}`,
    layer: near(height, MIN_HEIGHT) ? ('pavement' as const) : ('curb' as const),
    length: maxZ - minZ,
    face: { offset, corners, area: Math.abs(twiceArea) / 2 },
  }
}

function coveredRectangle(faces: Face[], area: number): boolean {
  const [first, second] = faces
  if (!(first && second) || faces.length !== 2) {
    return false
  }
  const [a, b] = first.corners.filter((corner) => second.corners.includes(corner))
  return (
    a !== undefined &&
    b !== undefined &&
    a[0] !== b[0] &&
    a[2] !== b[2] &&
    new Set([...first.corners, ...second.corners]).size === 4 &&
    Math.abs(first.area + second.area - area) < 0.15
  )
}

function hiddenFaces(position: Accessor, indices: Accessor, toWorld: Mat4): Set<number> {
  const values = new Vec3()
  const vertices = [new Vec3(), new Vec3(), new Vec3()]
  const local = [0, 0, 0]
  const spans = new Map<string, Span>()
  for (let offset = 0; offset < indices.getCount(); offset += 3) {
    for (const [j, vertex] of vertices.entries()) {
      position.getElement(indices.getScalar(offset + j), local)
      toWorld.transformPoint(values.fromArray(local), vertex)
    }
    const match = roadFace(vertices, offset)
    if (!match) {
      continue
    }
    const span = spans.get(match.key) ?? { pavement: [], curb: [], length: match.length }
    span[match.layer].push(match.face)
    spans.set(match.key, span)
  }
  if (spans.size !== SPANS) {
    throw new Error(`Expected ${SPANS} coincident bank curb spans, found ${spans.size}`)
  }
  const hidden = new Set<number>()
  for (const { pavement, curb, length } of spans.values()) {
    if (
      !(
        coveredRectangle(pavement, length * MIN_HEIGHT) &&
        coveredRectangle(curb, length * MAX_HEIGHT)
      )
    ) {
      throw new Error('A bank curb span does not fully cover the lower road-facing strip')
    }
    for (const face of pavement) {
      hidden.add(face.offset)
    }
  }
  return hidden
}

/** Remove the lower face where the dressed stone curb already covers the same road-facing plane. */
export function removeHiddenBankCurbFaces(document: Document): number {
  const root = document.getRoot()
  const node = root.listNodes().find((entry) => entry.getName() === 'masonry-3')
  const part = node
    ?.getMesh()
    ?.listPrimitives()
    .find((entry) => entry.getMaterial()?.getName() === 'Masonry-1')
  const position = part?.getAttribute('POSITION')
  const indices = part?.getIndices()
  const data = indices?.getArray()
  if (!(node && part && position && indices && data)) {
    throw new Error('Missing Bank masonry curb geometry')
  }
  const hidden = hiddenFaces(position, indices, new Mat4().set(node.getWorldMatrix()))
  part.setIndices(
    indices.clone().setArray(data.filter((_, offset) => !hidden.has(offset - (offset % 3)))),
  )
  if (indices.listParents().every((parent) => parent === root)) {
    indices.dispose()
  }
  return hidden.size
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2)
  if (!(input && output) || resolve(input) === resolve(output)) {
    throw new Error('Supply a native Bank input GLB and a separate staged output GLB')
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(input)
  const removed = removeHiddenBankCurbFaces(document)
  await io.write(output, document)
  console.log(`Removed ${removed} fully covered Bank curb triangles`)
}
