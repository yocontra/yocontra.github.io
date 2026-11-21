/** Refit dressing around all four Quick Draw arenas without moving the existing props. */
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Accessor, type Document, Node, NodeIO, type vec3 } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, getBounds, unpartition } from '@gltf-transform/functions'
import { projectedUv } from './animal-prop-surfaces.ts'
import { withContentOutput } from './content-output.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const native = 'public/experiments/out-west/3d/native-v2'
const arenas = ['duel', 'depot', 'mission', 'bank'] as const
const dressingPlacement = /^ambiance\.dressing\.\d+$/u

interface Model {
  doc: Document
  node: Node
}

async function loadArt(path: string): Promise<Map<string, Model>> {
  const [art, cashbox] = await Promise.all([
    io.read(path),
    io.read(join(native, 'dynamic/strongbox.glb')),
  ])
  const props = new Map(
    (art.getRoot().listScenes()[0]?.listChildren() ?? []).map((node) => [
      node.getName(),
      { doc: art, node },
    ]),
  )
  const chest = cashbox.getRoot().listScenes()[0]?.listChildren()[0]
  if (!chest) {
    throw new Error('Missing the authored bank strongbox')
  }
  props.set('k_chest_kit', { doc: cashbox, node: chest })
  return props
}

function finishOak(doc: Document, model: Node, grain: Uint8Array): void {
  let scan = doc
    .getRoot()
    .listTextures()
    .find((texture) => texture.getName() === 'Arena oak')
  model.traverse((node) => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const material = primitive.getMaterial()
      if (!material?.getName().startsWith('Oak')) {
        continue
      }
      scan ??= doc.createTexture('Arena oak').setImage(grain).setMimeType('image/webp')
      material.setBaseColorTexture(scan)
      if (!primitive.getAttribute('TEXCOORD_0')) {
        projectedUv(doc, primitive, 3)
      }
    }
  })
}

function fitDimensions(canonical: Accessor, art: Node) {
  const low = canonical.getMinNormalized([])
  const high = canonical.getMaxNormalized([])
  const { min, max } = getBounds(art)
  const scale: vec3 = [0, 0, 0]
  const offset: vec3 = [0, 0, 0]
  for (const axis of [0, 1, 2] as const) {
    const a = low[axis]
    const b = high[axis]
    const extent = max[axis] - min[axis]
    if (a === undefined || b === undefined || a >= b || extent <= 0) {
      throw new Error(`Invalid prop fit for ${art.getName()}`)
    }
    scale[axis] = (b - a) / extent
    offset[axis] = a - min[axis] * scale[axis]
  }
  return { scale, offset }
}

/** Leave the legacy placement and every unrelated primitive intact in an overlay bake. */
export async function fitArenaProps(doc: Document, path: string): Promise<number> {
  const [art, grain] = await Promise.all([
    loadArt(path),
    readFile('public/experiments/out-west/3d/tex/planks_diff.webp'),
  ])
  const placements = doc
    .getRoot()
    .listNodes()
    .filter((node) => dressingPlacement.test(node.getName()))
  if (placements.length === 0) {
    throw new Error('Missing Quick Draw dressing placements')
  }
  for (const site of placements) {
    const original = site.listChildren()[0]
    const canonical = original?.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
    const name = original?.getName() ?? ''
    const source = art.get(name)
    if (!(site.listChildren().length === 1 && original && canonical && source)) {
      throw new Error(`Invalid arena placement ${site.getName()} ${name}`)
    }
    const { scale, offset } = fitDimensions(canonical, source.node)
    const model = copyToDocument(doc, source.doc, [source.node]).get(source.node)
    if (!(model instanceof Node)) {
      throw new Error(`Missing copied arena prop ${name}`)
    }
    finishOak(doc, model, grain)
    const wrapper = doc
      .createNode(`fitted.ambiance.${name}`)
      .setScale(scale)
      .setTranslation(offset)
      .addChild(model)
    original.setMesh(null).addChild(wrapper)
  }
  await doc.transform(unpartition())
  return placements.length
}

if (import.meta.main) {
  const [, , source, output] = process.argv
  if (!(source && output) || resolve(source) === resolve(output)) {
    throw new Error('Give separate native input and output directories')
  }
  await mkdir(output, { recursive: true })
  for (const arena of arenas) {
    const file = `${arena}.glb`
    const doc = await io.read(join(source, file))
    const count = await fitArenaProps(doc, 'tools/art/environments/arena-props.glb')
    const target = join(output, file)
    await io.write(target, doc)
    await withContentOutput(join(output, 'resources'), () => compressEnvironmentTextures(target))
    console.log(arena, count, 'fitted props')
  }
}
