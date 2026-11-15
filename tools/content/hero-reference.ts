/** Bake the anatomical source into an isolated native hero for visual/animation review. */
import { resolve } from 'node:path'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, transformPrimitive } from '@gltf-transform/functions'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import type { Range } from './character-atlas.ts'
import { bakeCharacter } from './character-materials.ts'
import { withContentOutput } from './content-output.ts'
import { applyTextureQuality } from './optimize.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const directory = resolve('tools/art/characters/hero')
const replaced = new Set([
  'Skin',
  'Eye',
  'Brows',
  'Hair',
  'WesternSleeves',
  'WesternShirt',
  'ShirtTailoring',
])

function fitHat(doc: Document, hat: Document): void {
  if (hat.getRoot().getExtras().coordinateSpace !== 'Head local') {
    throw new Error('Hero hat must be authored in the native Head mount frame')
  }
  const mount = doc
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'mount.Head.accessory')
  if (!mount) {
    throw new Error('Missing canonical detachable hat mount')
  }
  for (const child of mount.listChildren()) {
    mount.removeChild(child)
  }
  mount.setMesh(null).setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1])
  const hatMesh = doc.createMesh('Hero fitted felt hat')
  for (const node of hat.getRoot().listNodes()) {
    for (const source of node.getMesh()?.listPrimitives() ?? []) {
      const primitive = copyToDocument(doc, hat, [source]).get(source) as Primitive
      transformPrimitive(primitive, node.getWorldMatrix())
      hatMesh.addPrimitive(primitive)
    }
  }
  mount.addChild(doc.createNode('Hero felt crown and brim').setMesh(hatMesh))
}

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
  const [anatomy, eyes, collar, hat, sleeves] = await Promise.all([
    io.read(resolve(directory, 'hero-skin-reference.glb')),
    io.read(resolve(directory, 'hero-eyes-reference.glb')),
    io.read(resolve(directory, 'hero-collar-reference.glb')),
    io.read(resolve(directory, 'hero-hat-reference.glb')),
    io.read(resolve(directory, 'hero-sleeves-reference.glb')),
  ])
  await Promise.all([anatomy, eyes, collar, hat, sleeves].map(validateAuthoringInputs))
  const names = skin.listJoints().map((joint) => joint.getName())
  if (JSON.stringify(names) !== JSON.stringify(anatomy.getRoot().getExtras().jointNames)) {
    throw new Error('Anatomical source and native hero joint order differ')
  }
  await Promise.all([anatomy, collar, sleeves].map((source) => applyTextureQuality(source, 'high')))
  const ranges = body.getExtras().pieceRanges as (Range & { name?: string })[]
  const removed = ranges.filter((range) => range.name && replaced.has(range.name))
  const kept: number[] = []
  const positions = original.getAttribute('POSITION')
  const obsoleteCollar = collar.getRoot().getExtras().replaceRanges as Range[]
  const collarEdge = collar.getRoot().getExtras().trimTailoringAboveY as number
  const tailoring = ranges.find((range) => range.name === 'ShirtTailoring')
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    const oldCollar =
      triangle.every((vertex) =>
        obsoleteCollar.some((range) => vertex >= range.start && vertex < range.start + range.count),
      ) ||
      Boolean(
        tailoring &&
          triangle.every(
            (vertex) =>
              vertex >= tailoring.start &&
              vertex < tailoring.start + tailoring.count &&
              (positions?.getElement(vertex, [])[1] ?? 0) > collarEdge,
          ),
      )
    if (
      !(
        oldCollar ||
        triangle.every((vertex) =>
          removed.some((range) => vertex >= range.start && vertex < range.start + range.count),
        )
      )
    ) {
      kept.push(...triangle)
    }
  }
  original.setIndices(indices.clone().setArray(Uint32Array.from(kept)))
  for (const surface of [anatomy, collar, sleeves]) {
    for (const source of surface
      .getRoot()
      .listMeshes()
      .flatMap((sourceMesh) => sourceMesh.listPrimitives())) {
      const primitive = copyToDocument(doc, surface, [source]).get(source) as Primitive
      primitive.setAttribute('JOINTS_0', primitive.getAttribute('_AUTHOR_JOINTS'))
      primitive.setAttribute('WEIGHTS_0', primitive.getAttribute('_AUTHOR_WEIGHTS'))
      primitive.setAttribute('_AUTHOR_JOINTS', null).setAttribute('_AUTHOR_WEIGHTS', null)
      mesh.addPrimitive(primitive)
    }
  }
  fitHat(doc, hat)
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
  const staging = resolve(process.env.OUT_WEST_HERO_CONTENT ?? '/tmp/out-west-hero-content')
  const target = resolve(staging, 'reference/baked/player.glb')
  await withContentOutput(staging, () =>
    bakeCharacter(resolve('tools/art/characters/player.gltf'), {
      prepare: prepareHeroReference,
      target,
    }),
  )
  console.log(`Reference only; production catalog unchanged: ${target}`)
}
