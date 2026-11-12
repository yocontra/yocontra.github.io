/** Scanned PBR surfaces for Perdition's authored geometry. */
import { readFile } from 'node:fs/promises'
import type { Document } from '@gltf-transform/core'
import sharp from 'sharp'

const scanRoot = 'tools/art/environments/textures'

/**
 * CC0 Poly Haven scan as native PBR. Vertex tints carry each surface's authored colour, so the
 * albedo is rescaled to a neutral mean while keeping the scan's own hue and value variation.
 */
export async function scanMaterial(
  doc: Document,
  role: string,
  id: string,
  options: { metallic?: number; size?: number } = {},
) {
  const { metallic = 0, size = 1024 } = options
  const albedo = await readFile(`${scanRoot}/${id}_diff.webp`)
  const { channels } = await sharp(albedo).stats()
  const gain = channels.slice(0, 3).map((channel) => 0.82 / Math.max(channel.mean / 255, 0.05))
  const image = async (kind: string) => {
    let pipeline = sharp(await readFile(`${scanRoot}/${id}_${kind}.webp`))
      .removeAlpha()
      .resize(size, size)
    if (kind === 'diff') {
      pipeline = pipeline.linear(gain, [0, 0, 0])
    }
    return doc
      .createTexture(`${id} ${kind}`)
      .setImage(await pipeline.webp({ lossless: true }).toBuffer())
      .setMimeType('image/webp')
  }
  const arm = await image('arm')
  return doc
    .createMaterial(role)
    .setBaseColorTexture(await image('diff'))
    .setNormalTexture(await image('nor'))
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
    .setMetallicFactor(metallic)
    .setRoughnessFactor(1)
}
