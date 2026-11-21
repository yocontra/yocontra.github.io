/** Scoped barrel timber/hoop authoring. Geometry only; runtime borrows the actual donor PBR. */
import { Document, type Primitive } from '@gltf-transform/core'
import { calculateNormals, calculateTangents, Mat4, Quat, Vec3 } from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'

import {
  type BarrelTriangle,
  cloneBarrelVertex as clone,
  conformBarrel,
  connectedBarrelPatch,
  interpolateBarrel as interpolate,
  barrelPointKey as key,
  type V2,
  type V3,
  type BarrelVertex as Vertex,
} from './barrel-topology.ts'

import { weatherBarrel } from './barrel-weathering.ts'

export type { BarrelTriangle } from './barrel-topology.ts'

const LOW_U = 0.004_654_377_698_898_315
const HIGH_U = 0.541_584_730_148_315_4
const HEIGHT = 0.95
const HEAD_Y = 0.858_194_112_777_71
const WALL = 0.028
const EPS = 1e-7
function clip(poly: Vertex[], value: (v: Vertex) => number): Vertex[] {
  const output: Vertex[] = []
  for (const [i, a] of poly.entries()) {
    const b = required(poly[(i + 1) % poly.length])
    const va = value(a)
    const vb = value(b)
    if (va >= -EPS) {
      output.push(a)
    }
    if ((va > EPS && vb < -EPS) || (va < -EPS && vb > EPS)) {
      output.push(interpolate(a, b, va / (va - vb)))
    }
  }
  return output
}
function fan(poly: Vertex[]): BarrelTriangle[] {
  const result: BarrelTriangle[] = []
  for (let i = 1; i < poly.length - 1; i++) {
    const tri: BarrelTriangle = [
      clone(required(poly[0])),
      clone(required(poly[i])),
      clone(required(poly[i + 1])),
    ]
    const edgeA = new Vec3(...tri[1].p).sub(new Vec3(...tri[0].p))
    const edgeB = new Vec3(...tri[2].p).sub(new Vec3(...tri[0].p))
    if (new Vec3().cross(edgeA, edgeB).lengthSq() > 1e-16) {
      result.push(tri)
    }
  }
  return result
}
/** Position-welded components distinguish the closed timber body and the three separate hoops. */
export function barrelComponents(primitive: Primitive): BarrelTriangle[][] {
  const positions = primitive.getAttribute('POSITION')
  const uv = primitive.getAttribute('TEXCOORD_0')
  const colors = primitive.getAttribute('COLOR_0')
  const normals = primitive.getAttribute('NORMAL')
  const indices = primitive.getIndices()
  if (!(positions && uv && colors && normals && indices)) {
    throw new Error('Incomplete donor barrel')
  }
  const vertices: Vertex[] = Array.from({ length: positions.getCount() }, (_, i) => ({
    p: positions.getElement(i, [0, 0, 0]) as V3,
    uv: uv.getElement(i, [0, 0]) as V2,
    color: colors.getElement(i, [0, 0, 0]).slice(0, 3) as V3,
    smooth: normals.getElement(i, [0, 0, 0]) as V3,
  }))
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id)
    if (!p) {
      parent.set(id, id)
      return id
    }
    if (p === id) {
      return id
    }
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const tris: BarrelTriangle[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const tri: BarrelTriangle = [
      clone(required(vertices[indices.getScalar(i)])),
      clone(required(vertices[indices.getScalar(i + 1)])),
      clone(required(vertices[indices.getScalar(i + 2)])),
    ]
    const root = find(key(tri[0].p))
    for (const vertex of tri.slice(1)) {
      parent.set(find(key(vertex.p)), root)
    }
    tris.push(tri)
  }
  const components = new Map<string, BarrelTriangle[]>()
  for (const tri of tris) {
    const id = find(key(tri[0].p))
    const group = components.get(id) ?? []
    group.push(tri)
    components.set(id, group)
  }
  return [...components.values()].sort((a, b) => b.length - a.length)
}
const bounds = (tris: BarrelTriangle[], axis: number) => {
  const values = tris.flatMap((tri) => tri.map((v) => required(v.p[axis])))
  return [Math.min(...values), Math.max(...values)] as const
}
export function tallBarrel(components: BarrelTriangle[][]): BarrelTriangle[][] {
  const wood = components[0]
  const scaleY = ENVIRONMENT_PROPS[0]?.binding.scale[1]
  if (
    !(wood && scaleY) ||
    components.length !== 4 ||
    wood.length !== 266 ||
    components.slice(1).some((part) => part.length !== 144)
  ) {
    throw new Error('Changed barrel donor topology')
  }
  if (ENVIRONMENT_PROPS.some((prop) => prop.binding.scale[1] !== scaleY)) {
    throw new Error('Unknown barrel height profile')
  }
  const [bottom, top] = bounds(wood, 1)
  const height = top - bottom
  if (!wood.some((tri) => tri.every((v) => Math.abs(v.p[1] - HEAD_Y) < 1e-8))) {
    throw new Error('Changed donor head plane')
  }
  const delta = HEIGHT / scaleY - height
  const topY = top + delta
  const headY = HEAD_Y + (delta * (HEAD_Y - bottom - 0.035)) / (height - 0.07)
  const stretch = (height + delta) / height
  const output: BarrelTriangle[][] = []
  for (const [partIndex, part] of components.entries()) {
    const [low, high] = bounds(part, 1)
    const shift = (delta * ((low + high) / 2 - bottom)) / height
    const result: BarrelTriangle[] = []
    for (const source of part) {
      const tri = source.map(clone) as BarrelTriangle
      for (const v of tri) {
        if (partIndex === 0) {
          lengthenTimber(v, { bottom, height, delta, topY, headY, scaleY })
        } else {
          v.p[1] += shift
        }
      }
      const span = Math.max(...source.map((v) => v.p[1])) - Math.min(...source.map((v) => v.p[1]))
      if (partIndex !== 0 || span < 0.1) {
        result.push(tri)
        continue
      }
      result.push(...woodUv(source, tri, stretch))
    }
    output.push(partIndex === 0 ? result : closeHoop(result))
  }
  return output.map(conformBarrel)
}

interface TimberProfile {
  bottom: number
  height: number
  delta: number
  topY: number
  headY: number
  scaleY: number
}
function lengthenTimber(v: Vertex, p: TimberProfile): void {
  v.p[1] += p.delta * Math.max(0, Math.min(1, (v.p[1] - p.bottom - 0.035) / (p.height - 0.07)))
  if (v.p[1] >= p.headY - 1e-8) {
    v.p[1] = p.topY - ((p.topY - v.p[1]) * (0.0005 / p.scaleY)) / (p.topY - p.headY)
  }
}

function woodUv(source: BarrelTriangle, tri: BarrelTriangle, stretch: number): BarrelTriangle[] {
  if (source.some((v) => v.uv[0] < LOW_U - 1e-5 || v.uv[0] > HIGH_U + 1e-5)) {
    throw new Error('Unexpected donor stave UV strip')
  }
  for (const v of tri) {
    v.uv[0] = LOW_U + (v.uv[0] - LOW_U) * stretch
  }
  const result = fan(clip(tri, (v) => HIGH_U - v.uv[0]))
  const wrapped = clip(tri, (v) => v.uv[0] - HIGH_U)
  for (const v of wrapped) {
    v.uv[0] -= HIGH_U - LOW_U
  }
  result.push(...fan(wrapped))
  return result
}

function boundary(tris: BarrelTriangle[]) {
  const edges = new Map<
    string,
    {
      a: Vertex
      b: Vertex
      count: number
    }
  >()
  for (const tri of tris) {
    for (let i = 0; i < 3; i++) {
      const a = required(tri[i])
      const b = required(tri[(i + 1) % 3])
      const id = [key(a.p), key(b.p)]
        .sort((left, right) => {
          if (left < right) {
            return -1
          }
          return left > right ? 1 : 0
        })
        .join('|')
      const edge = edges.get(id)
      if (edge) {
        edge.count++
      } else {
        edges.set(id, { a, b, count: 1 })
      }
    }
  }
  return [...edges.values()].filter((edge) => edge.count === 1)
}
function stave(patch: BarrelTriangle[]): BarrelTriangle[] {
  const inner = (v: Vertex) => {
    const copy = clone(v)
    const r = Math.hypot(v.p[0], v.p[2])
    if (r < WALL) {
      throw new Error('Invalid timber stave radius')
    }
    copy.p[0] *= (r - WALL) / r
    copy.p[2] *= (r - WALL) / r
    copy.smooth = copy.smooth.map((n) => -n) as V3
    return copy
  }
  const output = [
    ...patch,
    ...patch.map(([a, b, c]): BarrelTriangle => [inner(c), inner(b), inner(a)]),
  ]
  for (const [i, edge] of boundary(patch).entries()) {
    const quad = [clone(edge.b), clone(edge.a), inner(edge.a), inner(edge.b)]
    const length = new Vec3(...edge.a.p).distance(new Vec3(...edge.b.p))
    const span = Math.min(0.4, length * 0.6)
    const uv: V2[] = [
      [0.05, 0.465],
      [0.05 + span, 0.465],
      [0.05 + span, 0.467],
      [0.05, 0.467],
    ]
    quad.forEach((v, k) => {
      v.uv = required(uv[k])
      v.smooth = [i + 10, 0, 0]
    })
    output.push(...fan(quad))
  }
  return output
}
/** The donor hoop's two inner rings are open behind opaque timber; close them before fragmentation. */
function closeHoop(part: BarrelTriangle[]): BarrelTriangle[] {
  const edges = boundary(part)
  const heights = [...new Set(edges.map((edge) => key([0, edge.a.p[1], 0])))]
  if (heights.length !== 2) {
    throw new Error('Changed open hoop back profile')
  }
  const lower = Math.min(...edges.map((edge) => edge.a.p[1]))
  const bottom = edges.filter((edge) => Math.abs(edge.a.p[1] - lower) < 1e-6)
  const upper = edges.filter((edge) => Math.abs(edge.a.p[1] - lower) >= 1e-6)
  if (bottom.length !== upper.length) {
    throw new Error('Unmatched inner hoop rings')
  }
  const other = (vertex: Vertex) => {
    const angle = Math.atan2(vertex.p[2], vertex.p[0])
    const found = upper
      .map((edge) => edge.a)
      .find(
        (v) =>
          Math.abs(
            Math.atan2(
              Math.sin(Math.atan2(v.p[2], v.p[0]) - angle),
              Math.cos(Math.atan2(v.p[2], v.p[0]) - angle),
            ),
          ) < 1e-6,
      )
    if (!found) {
      throw new Error('Changed inner hoop correspondence')
    }
    return found
  }
  const copy = (vertex: Vertex) => {
    const v = clone(vertex)
    v.smooth = [42, 0, 0]
    return v
  }
  const added = bottom.flatMap(({ a, b }) =>
    fan([copy(b), copy(a), copy(other(a)), copy(other(b))]),
  )
  return [...part, ...added]
}
function hoop(part: BarrelTriangle[]): BarrelTriangle[] {
  const result = part.flatMap((tri) =>
    fan(
      clip(
        clip(tri, (v) => v.p[0]),
        (v) => v.p[2],
      ),
    ),
  )
  const edges = boundary(result)
  const starts = new Map(edges.map((edge) => [key(edge.a.p), edge]))
  while (starts.size > 0) {
    const first = required(starts.values().next().value)
    const loop = [first.a]
    const begin = key(first.a.p)
    let current = first
    do {
      starts.delete(key(current.a.p))
      loop.push(current.b)
      const next = starts.get(key(current.b.p))
      if (!next) {
        break
      }
      current = next
    } while (key(current.a.p) !== begin && loop.length <= edges.length + 1)
    if (key(required(loop.at(-1)).p) !== begin) {
      throw new Error('Open curved hoop boundary')
    }
    loop.pop()
    const center = clone(required(loop[0]))
    center.p = [0, 1, 2].map(
      (axis) => loop.reduce((sum, v) => sum + required(v.p[axis]), 0) / loop.length,
    ) as V3
    const planeX = Math.abs(center.p[0]) < 1e-6
    const cap = (v: Vertex) => {
      const vertex = clone(v)
      vertex.uv = [
        0.5 + ((planeX ? v.p[2] : v.p[0]) - (planeX ? center.p[2] : center.p[0])) * 0.25,
        0.567 + (v.p[1] - center.p[1]) * 0.05,
      ]
      vertex.smooth = planeX ? [-10, 0, 0] : [0, 0, -10]
      return vertex
    }
    for (let i = 0; i < loop.length; i++) {
      result.push([cap(center), cap(required(loop[(i + 1) % loop.length])), cap(required(loop[i]))])
    }
  }
  return result
}
export function barrelFragments(parts: BarrelTriangle[][]): BarrelTriangle[][] {
  const wood = required(parts[0])
  const result: BarrelTriangle[][] = []
  for (let index = 0; index < 4; index++) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 2 + Math.PI / 12
    const low = angle - (14 * Math.PI) / 180
    const high = angle + (14 * Math.PI) / 180
    const patch = wood.flatMap((tri) => {
      const center = tri.reduce((v, p) => v.add(new Vec3(...p.p)), new Vec3()).mulScalar(1 / 3)
      const normal = new Vec3()
        .cross(
          new Vec3(...tri[1].p).sub(new Vec3(...tri[0].p)),
          new Vec3(...tri[2].p).sub(new Vec3(...tri[0].p)),
        )
        .normalize()
      if (normal.dot(new Vec3(center.x, 0, center.z).normalize()) <= 0.6) {
        return []
      }
      return fan(
        clip(
          clip(tri, (v) => Math.cos(low) * v.p[2] - Math.sin(low) * v.p[0]),
          (v) => v.p[0] * Math.sin(high) - v.p[2] * Math.cos(high),
        ),
      )
    })
    if (patch.length === 0) {
      throw new Error('Missing donor stave patch')
    }
    result.push(stave(connectedBarrelPatch(conformBarrel(patch))))
  }
  result.push(hoop(required(parts[1])), hoop(required(parts[2])))
  return result
}
function addMesh(doc: Document, name: string, triangles: BarrelTriangle[]) {
  const positions: number[] = []
  const uv: number[] = []
  const colors: number[] = []
  const smooth: string[] = []
  for (const tri of triangles) {
    for (const v of tri) {
      positions.push(...v.p)
      uv.push(...v.uv)
      colors.push(...v.color)
      smooth.push(`${key(v.p)}:${key(v.smooth)}`)
    }
  }
  const welded = new Map<string, number>()
  const normalPositions: number[] = []
  const normalIndices: number[] = []
  for (const [index, id] of smooth.entries()) {
    let target = welded.get(id)
    if (target === undefined) {
      target = welded.size
      welded.set(id, target)
      normalPositions.push(...positions.slice(index * 3, index * 3 + 3))
    }
    normalIndices.push(target)
  }
  const joined = calculateNormals(normalPositions, normalIndices)
  const normals = normalIndices.flatMap((i) => [
    required(joined[i * 3]),
    required(joined[i * 3 + 1]),
    required(joined[i * 3 + 2]),
  ])
  const indices = positions
    .map((_, i) => i)
    .filter((i) => i % 3 === 0)
    .map((i) => i / 3)
  const tangents = calculateTangents(positions, normals, uv, indices)
  const buffer = required(doc.getRoot().listBuffers()[0])
  const accessor = (type: 'VEC2' | 'VEC3' | 'VEC4', data: number[] | Float32Array) =>
    doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(data))
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', positions))
    .setAttribute('NORMAL', accessor('VEC3', normals))
    .setAttribute('TEXCOORD_0', accessor('VEC2', uv))
    .setAttribute('COLOR_0', accessor('VEC3', colors))
    .setAttribute('TANGENT', accessor('VEC4', tangents))
    .setAttribute(
      'TEXCOORD_1',
      accessor(
        'VEC2',
        triangles.flatMap((tri) => tri.flatMap((v) => [v.p[0] / 1024, v.p[2] / 1024])),
      ),
    )
    .setIndices(
      doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint16Array(indices)),
    )
    .setMaterial(required(doc.getRoot().listMaterials()[0]))
  return doc.createMesh(name).addPrimitive(primitive)
}
/** No images or animation; all PBR/UV0 surfaces are borrowed from the actual source barrel. */
export function buildBarrelParts(primitive: Primitive): {
  library: Document
  fragments: Document
} {
  const components = tallBarrel(barrelComponents(primitive))
  weatherBarrel(components, bounds(required(components[0]), 1))
  const fragments = barrelFragments(components)
  const documents = [new Document(), new Document()]
  for (const doc of documents) {
    doc.createBuffer()
    doc.createMaterial('Borrow actual barrel PBR')
    doc.createScene('Authored responsive barrel parts')
  }
  const library = required(documents[0])
  const runtime = required(documents[1])
  required(library.getRoot().listScenes()[0]).addChild(
    library
      .createNode('barrel-tall')
      .setMesh(addMesh(library, 'Tall timber and translated hoops', components.flat())),
  )
  const positions = components.flat().flatMap((tri) => tri.map((v) => v.p))
  const pivot = new Vec3(
    -(Math.min(...positions.map((v) => v[0])) + Math.max(...positions.map((v) => v[0]))) / 2,
    -Math.min(...positions.map((v) => v[1])),
    -(Math.min(...positions.map((v) => v[2])) + Math.max(...positions.map((v) => v[2]))) / 2,
  )
  for (const [index, prop] of ENVIRONMENT_PROPS.entries()) {
    const matrix = new Mat4()
      .setTRS(
        new Vec3(...(prop.binding.translation as V3)),
        new Quat(...(prop.binding.rotation as [number, number, number, number])),
        new Vec3(...(prop.binding.scale as V3)),
      )
      .mul(new Mat4().setTranslate(pivot.x, pivot.y, pivot.z))
    for (const [piece, source] of fragments.entries()) {
      const world = source.map(
        (tri) =>
          tri.map((v) => {
            const copy = clone(v)
            copy.p = matrix.transformPoint(new Vec3(...v.p)).toArray() as V3
            return copy
          }) as BarrelTriangle,
      )
      const name = `barrel-debris:${index}:${piece < 4 ? `stave-${piece}` : `hoop-${piece - 4}`}`
      for (const doc of documents) {
        required(doc.getRoot().listScenes()[0]).addChild(
          doc.createNode(name).setMesh(addMesh(doc, name, world)),
        )
      }
    }
  }
  return { library, fragments: runtime }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Incomplete authored barrel data')
  }
  return value
}
