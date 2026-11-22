/** Pack the Blender head's authored maps into shared native skin textures. */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import sharp from 'sharp'
import { compressedCharacterTexture } from './character-textures.ts'

const [input, output] = process.argv.slice(2)
if (!(input && output)) {
  throw new Error('Usage: bun tools/content/starter-head-atlas.ts <Blender GLB> <art GLB>')
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const art = await io.read(input)
const skin = art
  .getRoot()
  .listMaterials()
  .find((material) => material.getName().startsWith('Field-worn skin'))

const color = skin?.getBaseColorTexture()?.getImage()
const bump = skin?.getNormalTexture()?.getImage()
if (!(skin && color && bump)) {
  throw new Error('The Blender head must contain skin color and normal textures')
}

const paint = await sharp(color)
  .removeAlpha()
  .resize(768, 768)
  .modulate({ brightness: 0.74, saturation: 0.92 })
  .png()
  .toBuffer()
const detail = await sharp(bump).removeAlpha().resize(512, 512).png().toBuffer()
const hair = art
  .getRoot()
  .listMaterials()
  .find((material) => material.getName() === 'Tobacco brown hair')
// The cropped scalp shares the skin atlas. Keep its follicles above the color quantization floor.
const encoding = hair ? 'etc1s' : 'uastc'
const [albedo, normal] = await Promise.all([
  compressedCharacterTexture(paint, true, 'characters', encoding),
  compressedCharacterTexture(detail, false),
])
skin
  .setName('Field-worn skin')
  .setBaseColorTexture(null)
  .setNormalTexture(null)
  .setRoughnessFactor(0.82)
  .setExtras({
    nativePbr: { albedo, normal, surface: 'skin', normalScale: 0.53, width: 768, height: 768 },
  })
const strands = hair?.getBaseColorTexture()?.getImage()
if (hair && strands) {
  const texture = await compressedCharacterTexture(strands, true)
  hair.setBaseColorTexture(null).setExtras({ nativePbr: { albedo: texture } })
}
await art.transform(prune({ keepAttributes: true }))
await io.write(output, art)
