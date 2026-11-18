import { MeshoptSimplifier } from 'meshoptimizer/simplifier'
import { Mesh, SEMANTIC_BLENDINDICES, SEMANTIC_BLENDWEIGHT, SEMANTIC_POSITION } from 'playcanvas'

const constructors = [
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
]
const normalized = [127, 255, 32_767, 65_535, 2_147_483_647, 4_294_967_295, 1]
const fields = [SEMANTIC_POSITION, SEMANTIC_BLENDINDICES, SEMANTIC_BLENDWEIGHT] as const
export const ready = MeshoptSimplifier.ready

function readStream(source: Mesh, semantic: (typeof fields)[number]) {
  const { format, numVertices: count } = source.vertexBuffer
  const element = format.elements.find((attribute) => attribute.name === semantic)
  const Constructor = element && constructors[element.dataType]
  if (!(element && Constructor && count)) {
    return
  }
  const data = new Constructor(count * element.numComponents)
  return source.getVertexStream(semantic, data) === count
    ? { semantic, element, data, Constructor }
    : undefined
}

type ShadowStream = NonNullable<ReturnType<typeof readStream>>

function decode(stream: ShadowStream, index: number): number {
  const value = stream.data[index] ?? 0
  const scale = normalized[stream.element.dataType] ?? 1
  return stream.element.normalize ? Math.max(-1, value / scale) : value
}

/** Keep the outline of geometry that bends across a joint. */
function jointBoundary(
  count: number,
  { data: indices }: ShadowStream,
  weights: ShadowStream,
  triangles: Uint32Array,
): Uint8Array {
  const dominant = new Uint16Array(count)
  for (let vertex = 0; vertex < count; vertex++) {
    const start = vertex * 4
    let winner = start
    for (let joint = start + 1; joint < start + 4; joint++) {
      if (decode(weights, joint) > decode(weights, winner)) {
        winner = joint
      }
    }
    dominant[vertex] = indices[winner] ?? 0
  }
  const locked = new Uint8Array(count)
  for (let offset = 0; offset + 2 < triangles.length; offset += 3) {
    const a = triangles[offset] ?? 0
    const b = triangles[offset + 1] ?? 0
    const c = triangles[offset + 2] ?? 0
    if (dominant[a] !== dominant[b] || dominant[b] !== dominant[c]) {
      locked[a] = 1
      locked[b] = 1
      locked[c] = 1
    }
  }
  return locked
}

function copyStream(mesh: Mesh, stream: ShadowStream, remap: Uint32Array, count: number) {
  const { semantic, element, data, Constructor } = stream
  const width = element.numComponents
  const values = new Constructor(count * width)
  for (let i = 0; i < remap.length; i++) {
    const to = remap[i]
    if (to !== undefined && to < count) {
      values.set(data.subarray(i * width, (i + 1) * width), to * width)
    }
  }
  mesh.setVertexStream(
    semantic,
    values,
    width,
    count,
    element.dataType,
    element.normalize,
    element.asInt,
  )
}

/** A shadow-only mesh uses the original bone indices and weights. The visible mesh is untouched. */
export function simplifyShadow(source: Mesh): Mesh | undefined {
  const primitive = source.primitive[0]
  const indexBuffer = source.indexBuffer[0]
  const [position, joints, weights] = fields.map((semantic) => readStream(source, semantic))
  if (!(primitive?.indexed && indexBuffer && position && joints && weights && source.skin)) {
    return
  }
  const vertexCount = position.data.length / 3
  if (
    position.element.numComponents !== 3 ||
    joints.element.numComponents !== 4 ||
    weights.element.numComponents !== 4
  ) {
    return
  }
  const indices = new Uint32Array(indexBuffer.numIndices)
  source.getIndices(indices)
  const triangles = indices.subarray(primitive.base, primitive.base + primitive.count)
  const contents = Float32Array.from(position.data, (_, i) => decode(position, i))
  const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
    triangles,
    contents,
    3,
    new Float32Array(vertexCount),
    1,
    [0],
    jointBoundary(vertexCount, joints, weights, triangles),
    Math.floor((triangles.length * 0.26) / 3) * 3,
    0.012,
    ['ErrorAbsolute', 'RegularizeLight'],
  )
  if (simplified.length === 0 || simplified.length > triangles.length * 0.85) {
    return
  }
  const [remap, compactCount] = MeshoptSimplifier.compactMesh(simplified)
  const mesh = new Mesh(source.device)
  try {
    for (const stream of [position, joints, weights]) {
      copyStream(mesh, stream, remap, compactCount)
    }
    mesh.setIndices(compactCount < 65_536 ? Uint16Array.from(simplified) : simplified)
    mesh.skin = source.skin
    mesh.update()
    return mesh
  } catch (error) {
    mesh.destroy()
    throw error
  }
}
