/** Export just the three native High-yard primitives from a staged Frontier bake. */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Document, type Mesh, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu, KHRTextureTransform } from '@gltf-transform/extensions'
import { copyToDocument, unpartition } from '@gltf-transform/functions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const material = 'Cactus yard two-arm authored color'

async function main(input: string, output: string): Promise<void> {
  const source = await io.read(input)
  const targets = source
    .getRoot()
    .listNodes()
    .flatMap((node) => {
      const mesh = node.getMesh()
      return node.getName() === 'prefab.saguaro_two_arm' &&
        mesh?.listPrimitives()[0]?.getMaterial()?.getName() === material
        ? [{ node, mesh }]
        : []
    })
  if (targets.length !== 3 || targets.some(({ mesh }) => mesh.listPrimitives().length !== 1)) {
    throw new Error('Expected the three authored Frontier yard plants')
  }
  const doc = new Document()
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  doc.createExtension(KHRTextureTransform)
  const copied = copyToDocument(
    doc,
    source,
    targets.map(({ mesh }) => mesh),
  )
  const scene = doc.createScene('Frontier High yard detail')
  for (const { node, mesh } of targets) {
    const part = copied.get(mesh)
    if (!part) {
      throw new Error('Missing exported Frontier yard mesh')
    }
    scene.addChild(
      doc
        .createNode(node.getName())
        .setMatrix(node.getWorldMatrix())
        .setMesh(part as Mesh),
    )
  }
  await doc.transform(unpartition())
  await mkdir(dirname(output), { recursive: true })
  await io.write(output, doc)
}

if (import.meta.main) {
  const [, , input, output] = process.argv
  if (!(input && output?.endsWith('/frontier-yard-high.glb'))) {
    throw new Error(
      'Usage: bun tools/content/frontier-yard-high.ts NATIVE_MAP.glb PATH/frontier-yard-high.glb',
    )
  }
  await main(input, output)
}
