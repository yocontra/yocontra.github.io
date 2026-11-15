import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, quantize, textureCompress, weld } from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'

export type TextureQuality = 'preserve' | 'high' | 'low' | 'legacy'

/** Source images stay byte-identical unless a runtime derivative profile is explicitly selected. */
function textureProfile(quality: TextureQuality) {
  switch (quality) {
    case 'preserve':
      return []
    case 'high':
    case 'low': {
      const size = quality === 'high' ? 4096 : 1024
      // Packed PBR channels and cutout coverage must not receive lossy colour compression.
      return [
        textureCompress({
          encoder: sharp,
          targetFormat: 'webp',
          resize: [size, size],
          lossless: true,
        }),
      ]
    }
    case 'legacy':
      // Existing production builds retain their old encoding until their art is requalified.
      return [
        textureCompress({
          encoder: sharp,
          targetFormat: 'webp',
          resize: [1024, 1024],
          quality: 80,
        }),
      ]
    default:
      throw new Error(`Unknown texture quality: ${quality}`)
  }
}

export function parseTextureQuality(value = 'preserve'): TextureQuality {
  if (value === 'preserve' || value === 'high' || value === 'low' || value === 'legacy') {
    return value
  }
  throw new Error(`Unknown texture quality: ${value}; use preserve, high, low or legacy`)
}

/** Standard glTF output: PlayCanvas does not decode the old Three meshopt extension. */
export async function optimizeAsset(path: string, quality: TextureQuality): Promise<void> {
  const textures = textureProfile(quality)
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
  await doc.transform(dedup(), weld(), prune(), quantize(), ...textures)
  await io.write(path, doc)
}
if (import.meta.main) {
  const args = process.argv.slice(2)
  const quality = parseTextureQuality(args.find((arg) => arg.startsWith('--textures='))?.slice(11))
  for (const path of args.filter((arg) => !arg.startsWith('--textures='))) {
    await optimizeAsset(path, quality)
    console.log(`optimized ${path}`)
  }
}
