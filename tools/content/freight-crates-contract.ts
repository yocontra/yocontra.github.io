import { createHash } from 'node:crypto'
import type { Document, Node } from '@gltf-transform/core'
import { getBounds } from '@gltf-transform/functions'
/** Offline freight packing, geometry and contact contracts; authoritative cover boxes stay fixed. */
export type Point = [number, number, number]
export type FreightFamily = 'shipping' | 'braced' | 'mercantile'
export interface FreightCover {
  kind: string
  x: number
  z: number
  w: number
  d: number
  top?: number
  y0?: number
}
export interface FreightCell {
  id: string
  coverIndex: number
  family: FreightFamily
  min: Point
  max: Point
  dimensions: Point
  model: string
}
export interface FreightPlacement {
  coverIndex: number
  min: Point
  max: Point
  counts: Point
  cells: FreightCell[]
}
export const FREIGHT_FAMILIES: FreightFamily[] = ['shipping', 'braced', 'mercantile']
export const FREIGHT_LOD = { distance: 10, hysteresis: 2 } as const
export const FREIGHT_TOLERANCE = 0.001
export const FREIGHT_SIDE_RECESS = 0.03

/** Confirm the existing generic-name groups still correspond to the frozen cover order. */
export function matchFreightPlacements(
  nodes: Node[],
  placements: FreightPlacement[],
): Map<number, Node> {
  if (nodes.length !== placements.length) {
    throw new Error('Crate subtree contract changed')
  }
  return new Map(
    nodes.map((node, index) => {
      const placement = placements[index]
      if (!placement) {
        throw new Error('Missing freight placement')
      }
      const bounds = getBounds(node)
      for (const axis of [0, 2]) {
        const actual = ((bounds.min[axis] ?? 0) + (bounds.max[axis] ?? 0)) / 2
        const expected = ((placement.min[axis] ?? 0) + (placement.max[axis] ?? 0)) / 2
        if (Math.abs(actual - expected) > 0.035) {
          throw new Error('Freight cover/subtree order changed')
        }
      }
      const parent = node.getParentNode()
      if (
        !parent ||
        parent
          .getWorldMatrix()
          .some((value, axis) => Math.abs(value - (axis % 5 === 0 ? 1 : 0)) > 1e-8)
      ) {
        throw new Error('Freight parent world transform changed')
      }
      return [placement.coverIndex, node]
    }),
  )
}

/** Every piece of body timber must be a real closed solid, not a two-sided cover plane. */
export function requireClosedFreight(faces: Point[][]): void {
  const edges = new Map<string, number>()
  const key = (point: Point) => point.map((value) => value.toFixed(7)).join(',')
  for (const face of faces) {
    if (face.length !== 3) {
      throw new Error('Incomplete freight body triangle')
    }
    const vertices = face.map(key)
    if (new Set(vertices).size !== 3) {
      throw new Error('Degenerate freight body triangle')
    }
    for (let index = 0; index < 3; index++) {
      const edge = [vertices[index], vertices[(index + 1) % 3]]
        .sort((a, b) => String(a).localeCompare(String(b), 'en'))
        .join('|')
      edges.set(edge, (edges.get(edge) ?? 0) + 1)
    }
  }
  if (edges.size === 0 || [...edges.values()].some((count) => count !== 2)) {
    throw new Error('Freight body is not a closed solid')
  }
  const anchor = faces[0]?.[0] ?? [0, 0, 0]
  let volume = 0
  for (const face of faces) {
    const [a, b, c] = face.map(
      (point) => point.map((value, axis) => value - (anchor[axis] ?? 0)) as Point,
    )
    if (!(a && b && c)) {
      throw new Error('Missing freight solid vertices')
    }
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) +
        a[1] * (b[2] * c[0] - b[0] * c[2]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6
  }
  if (!Number.isFinite(volume) || Math.abs(volume) < 1e-10) {
    throw new Error('Freight timber has no solid volume')
  }
}

function seed(text: string): number {
  let hash = 2_166_136_261
  for (const character of text) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619)
  }
  return hash >>> 0
}

/** Geometry is authored at these dimensions; boards are never stretched with a node scale. */
export function freightModel(family: FreightFamily, dimensions: Point): string {
  return `${family}-${dimensions.map((value) => value.toFixed(8)).join('x')}`
}

function freightCoordinates(counts: Point): Point[] {
  const result: Point[] = []
  for (let x = 0; x < counts[0]; x++) {
    for (let y = 0; y < counts[1]; y++) {
      for (let z = 0; z < counts[2]; z++) {
        const enclosed =
          x > 0 && x < counts[0] - 1 && z > 0 && z < counts[2] - 1 && y > 0 && y < counts[1] - 1
        if (!enclosed) {
          result.push([x, y, z])
        }
      }
    }
  }
  return result
}

export function packFreight(covers: readonly FreightCover[]): FreightPlacement[] {
  return covers.flatMap((cover, coverIndex) => {
    if (!(cover.kind === 'crates' || cover.kind === 'crate_stack')) {
      return []
    }
    const min: Point = [cover.x, cover.y0 ?? 0, cover.z]
    const dimensions: Point = [cover.w, (cover.top ?? 1) - min[1], cover.d]
    if (
      !(
        min.every(Number.isFinite) &&
        dimensions.every((value) => Number.isFinite(value) && value > 0)
      )
    ) {
      throw new Error(`Invalid freight cover ${coverIndex}`)
    }
    const max = min.map((value, axis) => value + (dimensions[axis] ?? 0)) as Point
    // Low cover keeps familiar small cases; tall freight uses genuinely larger authored cases.
    // A1.5m timber span /1.35m case height avoids the old under-fill without multiplying tiny boxes.
    const low = dimensions[1] <= 0.9
    const horizontal = (size: number) =>
      low ? Math.max(1, Math.round(size / 0.9)) : Math.max(1, Math.ceil(size / 1.5))
    const counts: Point = [
      horizontal(dimensions[0]),
      Math.max(1, Math.ceil(dimensions[1] / 1.35)),
      horizontal(dimensions[2]),
    ]
    const cells: FreightCell[] = []
    for (const coordinates of freightCoordinates(counts)) {
      const lower = min.map(
        (value, axis) =>
          value + ((dimensions[axis] ?? 0) * (coordinates[axis] ?? 0)) / (counts[axis] ?? 1),
      ) as Point
      const upper = min.map(
        (value, axis) =>
          value + ((dimensions[axis] ?? 0) * ((coordinates[axis] ?? 0) + 1)) / (counts[axis] ?? 1),
      ) as Point
      const size = upper.map((value, axis) => value - (lower[axis] ?? 0)) as Point
      const id = `${coverIndex}:${coordinates.join(':')}`
      const styleSeed = seed(id)
      const family = FREIGHT_FAMILIES[styleSeed % FREIGHT_FAMILIES.length]
      if (!family) {
        throw new Error('Missing freight construction family')
      }
      cells.push({
        id,
        coverIndex,
        family,
        min: lower,
        max: upper,
        dimensions: size,
        model: freightModel(family, size),
      })
    }
    return [{ coverIndex, min, max, counts, cells }]
  })
}

/** Face samples exercise contact surfaces, rather than accepting an AABB with an empty middle. */
export function freightFaceSamples(
  placement: Pick<FreightPlacement, 'min' | 'max'>,
  resolution = 7,
) {
  if (!Number.isInteger(resolution) || resolution < 2) {
    throw new Error('Freight face sampling requires at least two samples per axis')
  }
  const samples: { origin: Point; direction: Point; expectedDistance: number; face: string }[] = []
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    for (const side of [-1, 1]) {
      for (let i = 0; i < resolution; i++) {
        for (let j = 0; j < resolution; j++) {
          const point: Point = [0, 0, 0]
          point[axis] = (side < 0 ? placement.min[axis] : placement.max[axis]) ?? 0
          point[u] =
            (placement.min[u] ?? 0) +
            (((placement.max[u] ?? 0) - (placement.min[u] ?? 0)) * (i + 0.5)) / resolution
          point[v] =
            (placement.min[v] ?? 0) +
            (((placement.max[v] ?? 0) - (placement.min[v] ?? 0)) * (j + 0.5)) / resolution
          const direction: Point = [0, 0, 0]
          direction[axis] = -side
          point[axis] = (point[axis] ?? 0) + side * 0.1
          samples.push({ origin: point, direction, expectedDistance: 0.1, face: `${axis}:${side}` })
        }
      }
    }
  }
  return samples
}

export function requireFreightEnvelope(
  placement: Pick<FreightPlacement, 'min' | 'max'>,
  bounds: { min: Point; max: Point },
  hitDistance: (origin: Point, direction: Point) => number | null,
  samples = freightFaceSamples(placement),
): { maximumSideRecess: number; p95SideRecess: number; maximumContactError: number } {
  for (let axis = 0; axis < 3; axis++) {
    if (
      Math.abs((placement.min[axis] ?? 0) - (bounds.min[axis] ?? 0)) > FREIGHT_TOLERANCE ||
      Math.abs((placement.max[axis] ?? 0) - (bounds.max[axis] ?? 0)) > FREIGHT_TOLERANCE
    ) {
      throw new Error(`Freight envelope differs on axis ${axis}`)
    }
  }
  const recesses: number[] = []
  let maximumContactError = 0
  for (const sample of samples) {
    const distance = hitDistance(sample.origin, sample.direction)
    const horizontal = sample.direction[1] !== 0
    const allowed = horizontal ? FREIGHT_TOLERANCE : FREIGHT_SIDE_RECESS
    if (
      distance === null ||
      !Number.isFinite(distance) ||
      distance < sample.expectedDistance - FREIGHT_TOLERANCE ||
      distance > sample.expectedDistance + allowed
    ) {
      throw new Error(`Freight contact gap/protrusion on face ${sample.face}`)
    }
    if (horizontal) {
      maximumContactError = Math.max(
        maximumContactError,
        Math.abs(distance - sample.expectedDistance),
      )
    } else {
      recesses.push(Math.max(0, distance - sample.expectedDistance))
    }
  }
  recesses.sort((a, b) => a - b)
  return {
    maximumSideRecess: recesses.at(-1) ?? 0,
    p95SideRecess: recesses[Math.floor(recesses.length * 0.95)] ?? 0,
    maximumContactError,
  }
}

export function triangles(root: Node, hardware: boolean): Point[][] {
  const result: Point[][] = []
  const visit = (node: Node) => {
    const matrix = node.getWorldMatrix()
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      if (!hardware && node.getName().includes('hardware')) {
        continue
      }
      const positions = primitive.getAttribute('POSITION')
      const indices = primitive.getIndices()
      if (!(positions && indices)) {
        throw new Error('Freight model requires indexed triangles')
      }
      for (let i = 0; i < indices.getCount(); i += 3) {
        result.push(
          [0, 1, 2].map((offset) => {
            const [x = 0, y = 0, z = 0] = positions.getElement(indices.getScalar(i + offset), [])
            return [
              (matrix[0] ?? 0) * x +
                (matrix[4] ?? 0) * y +
                (matrix[8] ?? 0) * z +
                (matrix[12] ?? 0),
              (matrix[1] ?? 0) * x +
                (matrix[5] ?? 0) * y +
                (matrix[9] ?? 0) * z +
                (matrix[13] ?? 0),
              (matrix[2] ?? 0) * x +
                (matrix[6] ?? 0) * y +
                (matrix[10] ?? 0) * z +
                (matrix[14] ?? 0),
            ] as Point
          }),
        )
      }
    }
    for (const child of node.listChildren()) {
      visit(child)
    }
  }
  visit(root)
  return result
}
export function rayHit(faces: Point[][], origin: Point, direction: Point): number | null {
  let nearest = Number.POSITIVE_INFINITY
  for (const [a, b, c] of faces) {
    if (!(a && b && c)) {
      throw new Error('Incomplete freight triangle')
    }
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const ez = b[2] - a[2]
    const fx = c[0] - a[0]
    const fy = c[1] - a[1]
    const fz = c[2] - a[2]
    const hx = direction[1] * fz - direction[2] * fy
    const hy = direction[2] * fx - direction[0] * fz
    const hz = direction[0] * fy - direction[1] * fx
    const determinant = ex * hx + ey * hy + ez * hz
    if (Math.abs(determinant) < 1e-10) {
      continue
    }
    const sx = origin[0] - a[0]
    const sy = origin[1] - a[1]
    const sz = origin[2] - a[2]
    const u = (sx * hx + sy * hy + sz * hz) / determinant
    if (u < -1e-8 || u > 1 + 1e-8) {
      continue
    }
    const qx = sy * ez - sz * ey
    const qy = sz * ex - sx * ez
    const qz = sx * ey - sy * ex
    const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) / determinant
    const distance = (fx * qx + fy * qy + fz * qz) / determinant
    if (v >= -1e-8 && u + v <= 1 + 1e-8 && distance >= 0) {
      nearest = Math.min(nearest, distance)
    }
  }
  return Number.isFinite(nearest) ? nearest : null
}

export type FreightUv = [number, number]
export const FREIGHT_UV_PRECISION = 2 ** -24
export interface FreightSourceUv {
  name: string
  uv0ValueSetSHA256: string
  uv0UniqueValues: number
  uv0Values: FreightUv[]
}
/** Complete one-to-one matching; source points may not be dropped or merged. */
export function matchFreightUvValues(expected: FreightUv[], actual: FreightUv[]) {
  if (
    expected.length === 0 ||
    expected.length !== actual.length ||
    [...expected, ...actual].some((point) => point.length !== 2 || !point.every(Number.isFinite))
  ) {
    throw new Error('Freight UV cardinality/coordinate mismatch')
  }
  const error = (a: FreightUv, b: FreightUv) =>
    Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
  const edges = expected.map((source) =>
    actual
      .map((target, index) => ({ index, error: error(source, target) }))
      .filter((edge) => edge.error <= FREIGHT_UV_PRECISION)
      .sort((a, b) => a.error - b.error),
  )
  const owners = actual.map(() => -1)
  const assign = (source: number, seen: Set<number>): boolean => {
    for (const edge of edges[source] ?? []) {
      if (seen.has(edge.index)) {
        continue
      }
      seen.add(edge.index)
      const owner = owners[edge.index] ?? -1
      if (owner < 0 || assign(owner, seen)) {
        owners[edge.index] = source
        return true
      }
    }
    return false
  }
  for (let source = 0; source < expected.length; source++) {
    if (!assign(source, new Set())) {
      throw new Error('Freight authored UV0 differs beyond precision bound')
    }
  }
  const matches = owners.map((source, target) => ({
    source,
    target,
    error: error(expected[source] as FreightUv, actual[target] as FreightUv),
  }))
  return {
    maximumComponentError: Math.max(...matches.map((match) => match.error)),
    ambiguousValues: edges.filter((candidates) => candidates.length > 1).length,
    matches,
  }
}
function uvHex(point: FreightUv) {
  const bytes = Buffer.alloc(8)
  bytes.writeFloatLE(point[0], 0)
  bytes.writeFloatLE(point[1], 4)
  return bytes.toString('hex')
}
function uvHash(values: string[]) {
  return createHash('sha256')
    .update([...values].sort((a, b) => a.localeCompare(b, 'en')).join('\n'))
    .digest('hex')
}
/** UV0 layout is strict; only the measured Float32 export precision has a numeric bound. */
export function requireFreightUv0(doc: Document, expected: FreightSourceUv[] | undefined) {
  const nodes = doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh())
  if (!expected || nodes.length === 0 || nodes.length !== expected.length) {
    throw new Error('Freight source UV provenance count differs')
  }
  let uniqueCoordinates = 0
  const precisionCases: ({ name: string; sourceSHA256: string; actualSHA256: string } & ReturnType<
    typeof matchFreightUvValues
  >)[] = []
  for (const node of nodes) {
    const source = expected.find((piece) => piece.name === node.getName())
    const values = new Map<string, FreightUv>()
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const semantics = primitive
        .listSemantics()
        .filter((key) => key.startsWith('TEXCOORD_'))
        .sort()
      const uv = primitive.getAttribute('TEXCOORD_0')
      if (JSON.stringify(semantics) !== '["TEXCOORD_0"]' || !uv || uv.getType() !== 'VEC2') {
        throw new Error('Freight source requires authored UV0 only')
      }
      for (let index = 0; index < uv.getCount(); index++) {
        const point = uv.getElement(index, [0, 0]) as FreightUv
        values.set(uvHex(point), point)
      }
    }
    if (
      !source?.uv0Values ||
      values.size !== source.uv0UniqueValues ||
      new Set(source.uv0Values.map(uvHex)).size !== source.uv0UniqueValues ||
      uvHash(source.uv0Values.map(uvHex)) !== source.uv0ValueSetSHA256
    ) {
      throw new Error('Freight source UV provenance values differ')
    }
    const match = matchFreightUvValues(source.uv0Values, [...values.values()])
    const actualSHA256 = uvHash([...values.keys()])
    precisionCases.push({
      name: node.getName(),
      sourceSHA256: source.uv0ValueSetSHA256,
      actualSHA256,
      ...match,
    })
    uniqueCoordinates += values.size
  }
  return {
    pieces: nodes.length,
    uniqueCoordinates,
    authoredSampling: 'TEXCOORD_0',
    sourceUV1: 0,
    precisionBound: FREIGHT_UV_PRECISION,
    maximumObservedComponentError: Math.max(
      ...precisionCases.map((piece) => piece.maximumComponentError),
    ),
    ambiguousValues: precisionCases.reduce((sum, piece) => sum + piece.ambiguousValues, 0),
    precisionCases,
  }
}
