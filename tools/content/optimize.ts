import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, quantize, textureCompress, weld } from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'

/** Standard glTF output: PlayCanvas does not decode the old Three meshopt extension. */
export async function optimizeAsset(path: string): Promise<void> {
  await MeshoptDecoder.ready
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const doc = await io.read(path)
  const meshopt = doc
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
  meshopt?.dispose()
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        if (semantic.startsWith('_')) {
          primitive.setAttribute(semantic, null)
        }
      }
    }
  }
  await doc.transform(
    dedup(),
    weld(),
    prune(),
    quantize(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 80 }),
  )
  await io.write(path, doc)
}
if (import.meta.main) {
  for (const path of process.argv.slice(2)) {
    await optimizeAsset(path)
    console.log(`optimized ${path}`)
  }
}
