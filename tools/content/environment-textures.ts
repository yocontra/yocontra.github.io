/** Preserve native PBR image dimensions while encoding glTF's supported KHR_texture_basisu maps. */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions'
import { compressedCharacterTexture } from './character-textures.ts'
import { contentOutput } from './content-output.ts'

export async function compressEnvironmentTextures(path: string): Promise<void> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(path)
  const materials = document.getRoot().listMaterials()
  const textures = document.getRoot().listTextures()
  async function worker(index: number): Promise<void> {
    const texture = textures[index]
    if (!texture) {
      return
    }
    const bytes = texture.getImage()
    if (bytes && texture.getMimeType() !== 'image/ktx2') {
      const color = materials.some(
        (material) =>
          material.getBaseColorTexture() === texture || material.getEmissiveTexture() === texture,
      )
      const url = await compressedCharacterTexture(bytes, color, 'environments')
      texture
        .setImage(await readFile(contentOutput('environments', 'textures', basename(url))))
        .setMimeType('image/ktx2')
    }
    await worker(index + 2)
  }
  await Promise.all([worker(0), worker(1)])
  document.createExtension(KHRTextureBasisu).setRequired(true)
  await io.write(path, document)
}
