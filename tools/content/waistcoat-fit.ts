/** Replace obsolete apron geometry with a Blender-authored, natively skinned garment. */
import { resolve } from 'node:path'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { copyToDocument } from '@gltf-transform/functions'
import type { Range } from './character-atlas.ts'
import { appendAuthoredSurface, bindAuthoredSurface } from './garment-geometry.ts'
import pattern from './waistcoat-pattern.json' with { type: 'json' }

const io = new NodeIO()
export async function fitWaistcoats(doc: Document, id: string): Promise<void> {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const skin = node.getSkin()
    if (!(mesh && skin)) {
      continue
    }
    const ranges = (node.getExtras().pieceRanges ?? []) as Range[]
    for (const original of [...mesh.listPrimitives()]) {
      const fit = original.getExtras().waistcoatFit as { ranges: Range[] } | undefined
      const wool = fit?.ranges[0]
      if (!(fit && wool)) {
        continue
      }
      const authored = await io.read(resolve('tools/art/characters/waistcoats', `${id}.glb`))
      if (
        JSON.stringify(authored.getRoot().getExtras().jointNames) !==
        JSON.stringify(skin.listJoints().map((joint) => joint.getName()))
      ) {
        throw new Error(`Waistcoat ${id} has a different canonical skin`)
      }
      const source = authored.getRoot().listMeshes()[0]?.listPrimitives()[0]
      if (!source) {
        throw new Error(`Missing authored waistcoat ${id}`)
      }
      const garment = copyToDocument(doc, authored, [source]).get(source) as Primitive
      bindAuthoredSurface(garment, original, wool.start)
      stripCoveredShirt(original, ranges, fit.ranges)
      appendAuthoredSurface(
        original,
        garment,
        (original.getExtras().pieceRanges as Range[] | undefined) ?? ranges,
      )
      garment.dispose()
      original.setExtras({ ...original.getExtras(), waistcoatFit: undefined })
    }
  }
}
function patternDistance([u = 0, v = 0]: number[]): number {
  const front = Math.min(u, 1 - u)
  const back = Math.abs(u - 0.5)
  return Math.min(
    front < pattern.frontWidth ? pattern.frontDepth + pattern.frontSlope * front - v : 10,
    back < pattern.backWidth ? pattern.backDepth + pattern.backSlope * back - v : 10,
    ...pattern.armCenters.map(
      (center) =>
        0.1 *
        (((u - center) / pattern.armWidth) ** 2 +
          ((v - pattern.armLevel) / pattern.armHeight) ** 2 -
          1),
    ),
    v - pattern.hem,
  )
}
function stripCoveredShirt(primitive: Primitive, ranges: Range[], obsolete: Range[]): void {
  const position = primitive.getAttribute('POSITION')
  const uv = primitive.getAttribute('TEXCOORD_0')
  const indices = primitive.getIndices()
  const shirt = ranges.find((range) => range.name === 'WesternShirt')
  if (!(position && uv && indices && shirt)) {
    throw new Error('A fitted waistcoat requires the canonical shirt substrate')
  }
  const inside = (index: number, range: Range) =>
    index >= range.start && index < range.start + range.count
  const points = Array.from({ length: shirt.count }, (_, i) => ({
    point: position.getElement(shirt.start + i, []),
    uv: uv.getElement(shirt.start + i, []),
  }))
  const lo = [0, 1].map((c) => Math.min(...points.map((p) => p.uv[c] ?? 0)))
  const hi = [0, 1].map((c) => Math.max(...points.map((p) => p.uv[c] ?? 0)))
  const under = ranges.filter((range) =>
    ['WesternShirt', 'ShirtTailoring', 'ShirtButtons'].includes(range.name ?? ''),
  )
  const decorative = under.filter((range) => range.name !== 'WesternShirt')
  const covered = new Map<number, boolean>()
  const test = (index: number): boolean => {
    if (!under.some((range) => inside(index, range))) {
      return false
    }
    const known = covered.get(index)
    if (known !== undefined) {
      return known
    }
    const point = position.getElement(index, [])
    let nearest = points[0]
    let distance = Number.POSITIVE_INFINITY
    for (const candidate of points) {
      const next = candidate.point.reduce(
        (sum, value, c) => sum + (value - (point[c] ?? 0)) ** 2,
        0,
      )
      if (next < distance) {
        nearest = candidate
        distance = next
      }
    }
    const result = Boolean(
      nearest &&
        distance < 0.0009 &&
        patternDistance(
          nearest.uv.map((v, c) => (v - (lo[c] ?? 0)) / ((hi[c] ?? 1) - (lo[c] ?? 0))),
        ) > 0.035,
    )
    covered.set(index, result)
    return result
  }
  const keep: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    if (
      !(
        triangle.every((vertex) => obsolete.some((range) => inside(vertex, range))) ||
        triangle.every(test) ||
        (triangle.every((vertex) => decorative.some((range) => inside(vertex, range))) &&
          triangle.some(test))
      )
    ) {
      keep.push(...triangle)
    }
  }
  indices.setArray(Uint32Array.from(keep))
}
