/** Integrate portable Blender garment patches before canonical triangle filtering. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { type Document, type Node, NodeIO, type Primitive } from '@gltf-transform/core'
import { copyToDocument } from '@gltf-transform/functions'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import type { Range } from './character-atlas.ts'
import { appendAuthoredSurface, bindAuthoredSurface } from './garment-geometry.ts'

interface Metadata {
  jointNames: string[]
  sourceId: string
  sourceSHA256: string
  sourcePrimitive: { nodeIndex: number; meshIndex: number; primitiveIndex: number }
  replaceRanges: Range[]
  removeTriangles: number[]
}
interface Artifact {
  source: Document
  primitive: Primitive
  metadata: Metadata
  node: Node
  target: Primitive
}
const io = new NodeIO()
async function artifacts(doc: Document, id: string): Promise<Artifact[]> {
  const entries: Artifact[] = []
  const bytes = Buffer.from(
    await Bun.file(resolve('tools/art/characters', `${id}.gltf`)).arrayBuffer(),
  )
  const input = JSON.parse(bytes.toString()) as { buffers: { uri: string }[] }
  const buffers = await Promise.all(
    input.buffers.map((buffer) =>
      Bun.file(resolve('tools/art/characters', buffer.uri)).arrayBuffer(),
    ),
  )
  const digest = createHash('sha256').update(bytes)
  for (const buffer of buffers) {
    digest.update(new Uint8Array(buffer))
  }
  const hash = digest.digest('hex')
  for (const category of ['coat-sleeves', 'boot-bridges', 'coat-collars', 'shirt-fronts']) {
    const path = resolve('tools/art/characters', category, `${id}.glb`)
    if (!(await Bun.file(path).exists())) {
      continue
    }
    const source = await io.read(path)
    if (source.getRoot().getExtras().sourceInputs) {
      await validateAuthoringInputs(source)
    }
    const metadata = source.getRoot().getExtras() as unknown as Metadata
    const node = doc.getRoot().listNodes()[metadata.sourcePrimitive.nodeIndex]
    const mesh = node?.getMesh()
    const target = mesh?.listPrimitives()[metadata.sourcePrimitive.primitiveIndex]
    const primitive = source.getRoot().listMeshes()[0]?.listPrimitives()[0]
    if (
      !(node && mesh && target && primitive) ||
      metadata.sourceId !== id ||
      metadata.sourceSHA256 !== hash ||
      doc.getRoot().listMeshes().indexOf(mesh) !== metadata.sourcePrimitive.meshIndex
    ) {
      throw new Error(`Stale or incompatible authored ${category}/${id}`)
    }
    if (
      JSON.stringify(
        node
          .getSkin()
          ?.listJoints()
          .map((j) => j.getName()),
      ) !== JSON.stringify(metadata.jointNames)
    ) {
      throw new Error(`Authored ${category}/${id} has a different skin`)
    }
    entries.push({ source, primitive, metadata, node, target })
  }
  return entries
}
function trimOriginal(primitive: Primitive, entries: Artifact[]): void {
  const indices = primitive.getIndices()
  if (!indices) {
    throw new Error('Authored garments require original native indices')
  }
  const removed = new Set(entries.flatMap((entry) => entry.metadata.removeTriangles))
  const ranges = entries.flatMap((entry) => entry.metadata.replaceRanges)
  const keep: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    if (
      removed.has(i / 3) ||
      triangle.every((vertex) =>
        ranges.some((range) => vertex >= range.start && vertex < range.start + range.count),
      )
    ) {
      continue
    }
    keep.push(...triangle)
  }
  primitive.setIndices(indices.clone().setArray(Uint32Array.from(keep)))
}
export async function integrateGarmentParts(doc: Document, id: string): Promise<void> {
  const entries = await artifacts(doc, id)
  for (const target of new Set(entries.map((entry) => entry.target))) {
    const selected = entries.filter((entry) => entry.target === target)
    trimOriginal(target, selected)
    for (const entry of selected) {
      const copied = copyToDocument(doc, entry.source, [entry.primitive]).get(
        entry.primitive,
      ) as Primitive
      const ranges = (target.getExtras().pieceRanges ??
        entry.node.getExtras().pieceRanges ??
        []) as Range[]
      bindAuthoredSurface(copied, target, 0)
      appendAuthoredSurface(target, copied, ranges)
      copied.dispose()
    }
  }
}
