/** Ordinary offline installation of persisted freight prefabs; no Blender or runtime work. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Document, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { mergeDocuments } from '@gltf-transform/functions'
import { MODEL_LOD_PREFIX } from '../../src/experiments/out-west/content/types.ts'
import {
  FREIGHT_LOD,
  type FreightCell,
  type FreightPlacement,
  type Point,
} from './freight-crates-contract.ts'
import {
  checkFreightPlacement,
  cleanupFreightResources,
  cloneTree,
  freightOriginalState,
  removeTree,
  treeDigest,
} from './freight-crates-geometry.ts'
import {
  bakeFreightPositions,
  createFreightMaterial,
  type FreightPrototype,
} from './freight-crates-library.ts'

export interface FreightPrefabs {
  document: Document
  prototypes: Map<string, FreightPrototype>
  images: Buffer[]
}
export interface FreightPrefabManifest {
  library: { file: string; sha256: string }
  maps: { file: string; sha256: string }[]
  models: Pick<FreightCell, 'model' | 'family' | 'dimensions'>[]
  prototypes: [string, FreightPrototype][]
}
/** Read immutable standard glTF and map inputs once before installing them. */
export async function readFreightPrefabs(directory: string): Promise<FreightPrefabs> {
  const manifest = JSON.parse(
    await readFile(join(directory, 'profiles.json'), 'utf8'),
  ) as FreightPrefabManifest
  const read = async (file: { file: string; sha256: string }) => {
    const bytes = await readFile(join(directory, file.file))
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Changed freight prefab input: ${file.file}`)
    }
    return bytes
  }
  const library = await read(manifest.library)
  const images = await Promise.all(manifest.maps.map(read))
  return {
    document: await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(library),
    prototypes: new Map(manifest.prototypes),
    images,
  }
}

interface AssemblyContext {
  doc: Document
  templates: Map<string, Node>
  material: import('@gltf-transform/core').Material
  prototypes: Map<string, FreightPrototype>
}
function dressTree(context: AssemblyContext, node: Node): void {
  for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    primitive.setMaterial(context.material)
  }
  for (const child of node.listChildren()) {
    dressTree(context, child)
  }
}
function appendCell(
  context: AssemblyContext,
  options: { cell: FreightCell; branch: Node; center: Point; tier: string },
) {
  const { cell, branch, center, tier } = options
  const template = context.templates.get(`freight:${cell.model}:${tier}`)
  if (!template) {
    throw new Error(`Missing authored freight ${cell.model}:${tier}`)
  }
  const instance = context.doc
    .createNode(`freight-cell:${cell.id}`)
    .setTranslation([
      (cell.min[0] + cell.max[0]) / 2 - center[0],
      cell.min[1] - center[1],
      (cell.min[2] + cell.max[2]) / 2 - center[2],
    ])
  const copy = cloneTree(context.doc, template)
  instance.addChild(copy)
  branch.addChild(instance)
  dressTree(context, copy)
  const prototype = context.prototypes.get(template.getName())
  if (!prototype) {
    throw new Error('Missing freight prototype provenance')
  }
  return { cell: cell.id, prototype: template.getName(), ...prototype }
}
export function replaceFreightPlacement(
  context: AssemblyContext,
  placement: FreightPlacement,
  original: Node,
) {
  const parent = original.getParentNode()
  if (!parent) {
    throw new Error('Missing original freight parent')
  }
  const center = placement.min.map(
    (value, axis) => (value + (placement.max[axis] ?? 0)) / 2,
  ) as Point
  const group = context.doc
    .createNode(
      `${MODEL_LOD_PREFIX}${FREIGHT_LOD.distance}:${FREIGHT_LOD.hysteresis}:freight-${placement.coverIndex}`,
    )
    .setTranslation(center)
  parent.addChild(group)
  const entries = ['near', 'far'].map((tier) => {
    const branch = context.doc.createNode(`lod-${tier}:freight-${placement.coverIndex}`)
    group.addChild(branch)
    return {
      tier,
      branch,
      cells: placement.cells.map((cell) => appendCell(context, { cell, branch, center, tier })),
    }
  })
  const validate = () =>
    entries.map(({ tier, branch, cells }) => checkFreightPlacement(placement, branch, tier, cells))
  let fallbackReason: string | null = null
  let maximumSeamCorrection = 0
  let checks: ReturnType<typeof validate>
  try {
    checks = validate()
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        ['Freight contact', 'Freight envelope'].some((prefix) => error.message.startsWith(prefix))
      )
    ) {
      throw error
    }
    fallbackReason = error.message
    for (const entry of entries) {
      maximumSeamCorrection = Math.max(
        maximumSeamCorrection,
        bakeFreightPositions(context.doc, entry.branch, placement, entry.cells),
      )
    }
    checks = validate()
  }
  removeTree(original)
  return checks.map((check) => ({
    ...check,
    representation: fallbackReason ? 'baked-position' : 'shared-prototype',
    fallbackReason,
    maximumSeamCorrection,
  }))
}
/** Pure document mutation. Missing new profile dimensions fail before the target is changed. */
export function installFreightCrates(
  doc: Document,
  prefabs: FreightPrefabs,
  placements: FreightPlacement[],
  selected = placements.map((placement) => placement.coverIndex),
) {
  const library = prefabs.document
  const required = placements.filter((placement) => selected.includes(placement.coverIndex))
  const available = new Set(
    library
      .getRoot()
      .listNodes()
      .map((node) => node.getName()),
  )
  for (const cell of required.flatMap((placement) => placement.cells)) {
    for (const tier of ['near', 'far']) {
      const key = `freight:${cell.model}:${tier}`
      if (!(available.has(key) && prefabs.prototypes.has(key))) {
        throw new Error(
          `Missing freight profile ${cell.model}:${tier}; regenerate the freight prefab library for these dimensions`,
        )
      }
    }
  }
  const { originals, originalScenes, originalNodes, originalResources, unaffected } =
    freightOriginalState(doc, placements, selected)
  const merged = mergeDocuments(doc, library)
  const templates = new Map(
    library
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), merged.get(node) as Node]),
  )
  const context = {
    doc,
    templates,
    material: createFreightMaterial(doc, prefabs.images),
    prototypes: prefabs.prototypes,
  }
  const checks = required.flatMap((placement) => {
    const original = originals.get(placement.coverIndex)
    if (!original) {
      throw new Error('Missing original freight placement')
    }
    return replaceFreightPlacement(context, placement, original)
  })
  for (const node of doc.getRoot().listNodes()) {
    if (
      !originalNodes.has(node) &&
      node.getName().startsWith('freight:') &&
      node.getParentNode() === null
    ) {
      removeTree(node)
    }
  }
  for (const scene of doc.getRoot().listScenes()) {
    if (!originalScenes.has(scene)) {
      scene.dispose()
    }
  }
  const resources = cleanupFreightResources(doc, originalResources)
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  for (const accessor of doc.getRoot().listAccessors()) {
    accessor.setBuffer(buffer)
  }
  for (const extra of doc.getRoot().listBuffers().slice(1)) {
    extra.dispose()
  }
  for (const [node, before] of unaffected) {
    if (node.isDisposed() || treeDigest(node, false) !== before) {
      throw new Error(`Unrelated frontier geometry changed: ${node.getName()}`)
    }
  }
  return { checks, resources, unchangedNodeCount: unaffected.size }
}
