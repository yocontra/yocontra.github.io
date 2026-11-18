/** Bake large-scale plaster wear into the adobe vertex colors. The original tiled maps supply grain. */
import type { Document } from '@gltf-transform/core'
import { math, Vec3 } from 'playcanvas'
import { scanMaterial } from './frontier-surfaces.ts'

const { clamp, lerp } = math

const STREAMS = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'] as const
const HEIGHT_CUTS = [0.35, 0.7, 1.15, 1.7, 2.45, 3.25, 4.35, 5.1]
const WALL_SPACING = 1.35
type Axis = 0 | 1 | 2
type Vertex = number[]

function lattice(x: number, y: number, seed: number): number {
  const bits = Math.imul(x ^ Math.imul(seed, 9001), 1_597_334_677) ^ Math.imul(y, 3_812_015_801)
  return (Math.imul(bits ^ (bits >>> 16), 0x4_5d_9f_3b) >>> 0) / 0xff_ff_ff_ff
}

function smooth(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function noise(x: number, y: number, seed: number): number {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const u = smooth(x - i)
  const v = smooth(y - j)
  return lerp(
    lerp(lattice(i, j, seed), lattice(i + 1, j, seed), u),
    lerp(lattice(i, j + 1, seed), lattice(i + 1, j + 1, seed), u),
    v,
  )
}

function wear(vertex: Vertex, along: 0 | 2): [number, number, number] {
  const u = vertex[along] ?? 0
  const y = vertex[1] ?? 0
  const plane = vertex[along === 0 ? 2 : 0] ?? 0
  const seed = Math.round(plane * 20)
  const patch = 0.72 * noise(u * 0.51, y * 0.8, seed) + 0.28 * noise(u * 1.2, y * 1.4, seed)
  const baseHeight = 0.75 + 0.58 * noise(u * 0.55, 12, seed)
  const damp = 0.4 * smooth(1 - y / baseHeight)
  // Patchy old limewash over the warmer clay. Runoff is vertically stretched between coats.
  const lime = 0.53 * smooth((patch - 0.32) / 0.51) * smooth((y - 0.28) / 0.85)
  const runoff = 0.15 * smooth((noise(u * 0.8, y * 0.23, seed + 7) - 0.63) / 0.32)
  return [
    1 - damp * 0.86 + lime * 0.58 - runoff,
    1 - damp + lime - runoff,
    1 - damp + lime * 1.23 - runoff,
  ]
}

function split(polygon: readonly Vertex[], axis: Axis, cut: number): [Vertex[], Vertex[]] {
  const below: Vertex[] = []
  const above: Vertex[] = []
  for (const [i, next] of polygon.entries()) {
    const previous = polygon[(i + polygon.length - 1) % polygon.length]
    if (!previous) {
      continue
    }
    const a = previous[axis] ?? 0
    const b = next[axis] ?? 0
    if ((a < cut && b > cut) || (a > cut && b < cut)) {
      const point = previous.map((value, k) => lerp(value, next[k] ?? value, (cut - a) / (b - a)))
      below.push(point)
      above.push(point)
    }
    if (b <= cut) {
      below.push(next)
    }
    if (b >= cut) {
      above.push(next)
    }
  }
  return [below, above]
}

function bands(polygon: Vertex[], axis: Axis, cuts: readonly number[]): Vertex[][] {
  const parts: Vertex[][] = []
  let remaining = polygon
  for (const cut of cuts) {
    if (!remaining.some((point) => (point[axis] ?? 0) < cut)) {
      continue
    }
    if (!remaining.some((point) => (point[axis] ?? 0) > cut)) {
      break
    }
    const [below, above] = split(remaining, axis, cut)
    parts.push(below)
    remaining = above
  }
  parts.push(remaining)
  return parts
}

function wallPatches(triangle: Vertex[], along: 0 | 2): Vertex[][] {
  const values = triangle.map((point) => point[along] ?? 0)
  const maximum = Math.max(...values)
  const cuts: number[] = []
  for (
    let edge = (Math.floor(Math.min(...values) / WALL_SPACING) + 1) * WALL_SPACING;
    edge < maximum;
    edge += WALL_SPACING
  ) {
    cuts.push(edge)
  }
  return bands(triangle, along, cuts).flatMap((column) => bands(column, 1, HEIGHT_CUTS))
}

function missionAdobe(document: Document) {
  const instances = document
    .getRoot()
    .listNodes()
    .filter((node) => node.getName() === 'adobe-6')
  const primitive = instances[0]?.getMesh()?.listPrimitives()[0]
  const material = primitive?.getMaterial()
  if (instances.length !== 1 || !primitive || material?.getName() !== 'Adobe') {
    throw new Error('Missing the authored San Miguel adobe')
  }
  return { primitive, material }
}

/** Retain the recovered scan's physical repeat, with maps sized for the web build. */
export async function dressMissionAdobe(document: Document): Promise<void> {
  const { primitive, material } = missionAdobe(document)
  const uv = primitive.getAttribute('TEXCOORD_0')
  const values = uv?.getArray()
  if (!(uv && values)) {
    throw new Error('Missing mission adobe UVs')
  }
  const scan = await scanMaterial(document, 'Earth plaster source', 'clay_plaster', {
    size: 1024,
    dataSize: 512,
    albedoMean: null,
  })
  material
    .setBaseColorTexture(scan.getBaseColorTexture())
    .setNormalTexture(scan.getNormalTexture())
    .setMetallicRoughnessTexture(scan.getMetallicRoughnessTexture())
    .setOcclusionTexture(scan.getOcclusionTexture())
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setNormalScale(0.65)
  // The existing UVs repeat every 3.2 m. Clone the accessor before switching to the 2 m scan.
  primitive.setAttribute(
    'TEXCOORD_0',
    uv.clone().setArray(Float32Array.from(values, (value) => value * 1.6)),
  )
  material.setExtras({ ...material.getExtras(), earthPlasterRepeatMeters: 2 })
  scan.dispose()
  weatherMissionAdobe(document)
}

function weatherMissionAdobe(document: Document): void {
  const { primitive } = missionAdobe(document)
  const attributes = STREAMS.map((name) => primitive.getAttribute(name))
  const sizes = attributes.map((attribute) => attribute?.getElementSize())
  if (primitive.listSemantics().length !== STREAMS.length || sizes.join(',') !== '3,3,2,3') {
    throw new Error('Unexpected San Miguel adobe vertex streams')
  }
  const indices = primitive.getIndices()
  const count = indices?.getCount() ?? attributes[0]?.getCount() ?? 0
  const output = STREAMS.map(() => [] as number[])
  const read = (index: number) =>
    attributes.flatMap(
      (attribute) => attribute?.getElement(indices?.getScalar(index) ?? index, []) ?? [],
    )
  const emit = ([a, b, c]: readonly Vertex[], along?: 0 | 2) => {
    if (!(a && b && c)) {
      return
    }
    const origin = new Vec3().fromArray(a)
    const edge = new Vec3().fromArray(b).sub(origin)
    const other = new Vec3().fromArray(c).sub(origin)
    if (edge.cross(edge, other).lengthSq() < 1e-16) {
      return
    }
    for (const vertex of [a, b, c]) {
      const factor = along === undefined ? [1, 1, 1] : wear(vertex, along)
      output[0]?.push(...vertex.slice(0, 3))
      output[1]?.push(...vertex.slice(3, 6))
      output[2]?.push(...vertex.slice(6, 8))
      output[3]?.push(
        ...vertex.slice(8).map((value, channel) => clamp(value * (factor[channel] ?? 1), 0, 1)),
      )
    }
  }

  for (let i = 0; i < count; i += 3) {
    const triangle = [read(i), read(i + 1), read(i + 2)]
    if (triangle.some((point) => Math.abs(point[4] ?? 0) >= 0.12)) {
      emit(triangle)
      continue
    }
    const along = Math.abs(triangle[0]?.[3] ?? 0) > Math.abs(triangle[0]?.[5] ?? 0) ? 2 : 0
    for (const patch of wallPatches(triangle, along)) {
      for (let j = 2; j < patch.length; j++) {
        const a = patch[0]
        const b = patch[j - 1]
        const c = patch[j]
        if (a && b && c) {
          emit([a, b, c], along)
        }
      }
    }
  }
  for (const [index, name] of STREAMS.entries()) {
    const attribute = attributes[index]
    primitive.setAttribute(
      name,
      attribute?.clone().setArray(new Float32Array(output[index] ?? [])) ?? null,
    )
  }
  primitive.setIndices(null)
}
