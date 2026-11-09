/** Small shared authored PBR maps give rigid spurs a worn metal finish. */
import { resolve } from 'node:path'
import type { Primitive } from '@gltf-transform/core'
import sharp from 'sharp'
import { imageFile } from './character-atlas.ts'

const surfaces = new Map<number, Promise<{ albedo: string; normal: string; arm: string }>>()
async function surface(metal: number): Promise<{ albedo: string; normal: string; arm: string }> {
  const images = await Promise.all(
    ['color', 'normal', 'wear'].map((role) => {
      const file = resolve('tools/art/characters/textures', `worn-metal-${role}.png`)
      return sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    }),
  )
  const [color, normal, wear] = images
  if (!(color && normal && wear)) {
    throw new Error('Run Blender tools/content/metal-authoring.py first')
  }
  for (let i = 2; i < wear.data.length; i += 4) {
    wear.data[i] = Math.round((wear.data[i] ?? 255) * metal)
  }
  const [albedo, normals, arm] = await Promise.all([
    imageFile(color.data, color.info.width, color.info.height, true),
    imageFile(normal.data, normal.info.width, normal.info.height, false),
    imageFile(wear.data, wear.info.width, wear.info.height, false),
  ])
  return { albedo, normal: normals, arm }
}
export async function prepareSpurSurface(primitive: Primitive): Promise<void> {
  const material = primitive.getMaterial()
  if (!material || material.getBaseColorTexture()) {
    return
  }
  const metal = Math.max(0.82, material.getMetallicFactor())
  let result = surfaces.get(metal)
  if (!result) {
    result = surface(metal)
    surfaces.set(metal, result)
  }
  material
    .setMetallicFactor(1)
    .setRoughnessFactor(1)
    .setExtras({ nativePbr: await result })
}
