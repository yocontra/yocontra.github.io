import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Document, Node, NodeIO, type vec3 } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, getBounds, unpartition } from '@gltf-transform/functions'

import { withContentOutput } from './content-output.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'

const planks = /wood|felloe|underframe/u

/** Fit the wagon's local bounds to each existing arena cart, keeping its placement and yaw. */
export async function fitArenaWagons(doc: Document, path: string): Promise<void> {
  const carts = doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getName().startsWith('cart-'))
  if (carts.length === 0) {
    throw new Error('The arena has no named wagon placements')
  }
  const art = await new NodeIO().read(path)
  const template = art.getRoot().getDefaultScene()?.listChildren()[0]
  if (!template?.listChildren().length) {
    throw new Error('Missing authored wagon')
  }
  const artBounds = getBounds(template)
  const sourceParts = template.listChildren()
  const copied = copyToDocument(doc, art, sourceParts)
  const grain = doc
    .createTexture('Wagon oak grain')
    .setImage(await readFile('public/experiments/out-west/3d/tex/planks_diff.webp'))
    .setMimeType('image/webp')
  for (const component of sourceParts) {
    const part = copied.get(component)
    if (!(part instanceof Node && part.getMesh())) {
      throw new Error('Missing wagon component')
    }
    for (const primitive of part.getMesh()?.listPrimitives() ?? []) {
      const material = primitive.getMaterial()
      if (planks.test(material?.getName() ?? '')) {
        material?.setBaseColorTexture(grain)
      }
    }
  }
  for (const cart of carts) {
    const original = cart.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
    if (!original) {
      throw new Error(`Missing existing bounds for ${cart.getName()}`)
    }
    const min = original.getMinNormalized([])
    const max = original.getMaxNormalized([])
    const scale: vec3 = [0, 0, 0]
    const offset: vec3 = [0, 0, 0]
    for (const axis of [0, 1, 2] as const) {
      const span = artBounds.max[axis] - artBounds.min[axis]
      const start = min[axis]
      const end = max[axis]
      if (start === undefined || end === undefined || span <= 0 || end <= start) {
        throw new Error(`Invalid wagon bounds for ${cart.getName()}`)
      }
      scale[axis] = (end - start) / span
      offset[axis] = start - artBounds.min[axis] * scale[axis]
    }
    const fitted = doc.createNode('Fitted oak freight wagon').setTranslation(offset).setScale(scale)
    for (const part of sourceParts) {
      const model = copied.get(part) as Node
      fitted.addChild(
        doc.createNode(model.getName()).setMatrix(model.getMatrix()).setMesh(model.getMesh()),
      )
    }
    cart.setMesh(null).addChild(fitted)
  }
  for (const part of sourceParts) {
    copied.get(part)?.dispose()
  }
  await doc.transform(unpartition())
}

// Use the inspected, shipped arenas as input when updating only this asset family.
if (import.meta.main) {
  const [, , source, destination] = process.argv
  if (!(source && destination) || resolve(source) === resolve(destination)) {
    throw new Error('Give separate native arena input and output directories')
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const artwork = 'tools/art/environments/arena-wagon.glb'
  await mkdir(destination, { recursive: true })
  for (const arena of ['depot', 'mission', 'bank']) {
    const file = `${arena}.glb`
    const output = join(destination, file)
    const doc = await io.read(join(source, file))
    await fitArenaWagons(doc, artwork)
    await io.write(output, doc)
    await withContentOutput(join(destination, 'resources'), () =>
      compressEnvironmentTextures(output),
    )
  }
}
