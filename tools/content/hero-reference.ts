/** Bake the anatomical source into an isolated native hero for visual/animation review. */
import { resolve } from 'node:path'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, transformPrimitive } from '@gltf-transform/functions'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import type { Range } from './character-atlas.ts'
import { bakeCharacter } from './character-materials.ts'
import { applyTextureQuality } from './optimize.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const directory = resolve('tools/art/characters/hero')
const replaced = new Set(['Skin', 'Eye', 'Brows', 'Hair'])

export async function prepareHeroReference(doc: Document): Promise<void> {
  const body = doc
    .getRoot()
    .listNodes()
    .find((node) => node.getSkin() && node.getExtras().pieceRanges)
  const skin = body?.getSkin()
  const mesh = body?.getMesh()
  const original = mesh
    ?.listPrimitives()
    .find((primitive) => primitive.getAttribute('_STYLE_LUMINANCE'))
  const indices = original?.getIndices()
  if (!(body && skin && mesh && original && indices)) {
    throw new Error('Hero reference requires the canonical player skin and piece ranges')
  }
  const [anatomy, eyes] = await Promise.all([
    io.read(resolve(directory, 'hero-skin-reference.glb')),
    io.read(resolve(directory, 'hero-eyes-reference.glb')),
  ])
  await Promise.all([validateAuthoringInputs(anatomy), validateAuthoringInputs(eyes)])
  const names = skin.listJoints().map((joint) => joint.getName())
  if (JSON.stringify(names) !== JSON.stringify(anatomy.getRoot().getExtras().jointNames)) {
    throw new Error('Anatomical source and native hero joint order differ')
  }
  await applyTextureQuality(anatomy, 'high')
  const ranges = body.getExtras().pieceRanges as (Range & { name?: string })[]
  const removed = ranges.filter((range) => range.name && replaced.has(range.name))
  const kept: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    if (
      !triangle.every((vertex) =>
        removed.some((range) => vertex >= range.start && vertex < range.start + range.count),
      )
    ) {
      kept.push(...triangle)
    }
  }
  original.setIndices(indices.clone().setArray(Uint32Array.from(kept)))
  for (const sourceMesh of anatomy.getRoot().listMeshes()) {
    for (const source of sourceMesh.listPrimitives()) {
      const primitive = copyToDocument(doc, anatomy, [source]).get(source) as Primitive
      primitive.setAttribute('JOINTS_0', primitive.getAttribute('_AUTHOR_JOINTS'))
      primitive.setAttribute('WEIGHTS_0', primitive.getAttribute('_AUTHOR_WEIGHTS'))
      primitive.setAttribute('_AUTHOR_JOINTS', null).setAttribute('_AUTHOR_WEIGHTS', null)
      mesh.addPrimitive(primitive)
    }
  }
  const head = names.indexOf('Head')
  if (head < 0) {
    throw new Error('Hero eye reference requires a Head joint')
  }
  for (const node of eyes.getRoot().listNodes()) {
    for (const source of node.getMesh()?.listPrimitives() ?? []) {
      const primitive = copyToDocument(doc, eyes, [source]).get(source) as Primitive
      transformPrimitive(primitive, node.getWorldMatrix())
      const count = primitive.getAttribute('POSITION')?.getCount() ?? 0
      const jointValues = new Uint16Array(count * 4)
      const weightValues = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        jointValues[i * 4] = head
        weightValues[i * 4] = 1
      }
      const buffer = primitive.getAttribute('POSITION')?.getBuffer() ?? doc.createBuffer()
      primitive.setAttribute(
        'JOINTS_0',
        doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(jointValues),
      )
      primitive.setAttribute(
        'WEIGHTS_0',
        doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(weightValues),
      )
      mesh.addPrimitive(primitive)
    }
  }
  doc
    .getRoot()
    .setExtras({ ...doc.getRoot().getExtras(), heroReference: anatomy.getRoot().getExtras() })
}

if (import.meta.main) {
  const target = resolve('public/experiments/out-west/3d/native-v2/reference/baked/player.glb')
  await bakeCharacter(resolve('tools/art/characters/player.gltf'), {
    prepare: prepareHeroReference,
    target,
  })
  console.log(`Reference only; production catalog unchanged: ${target}`)
}
