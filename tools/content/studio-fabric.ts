/** Keep the photographed cloth and its yarn relief at the same scale on all three rider rigs. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Material, Texture } from '@gltf-transform/core'
import sharp from 'sharp'
import { DYES } from '../../src/experiments/out-west/data/dye.ts'

const clothUptake = new Map([
  ['Travel-worn jacket leather', 0.64],
  ['Weathered wool waistcoat', 0.7],
  ['Yarn-dyed workshirt', 0.24],
  ['Saddle-brown cotton duck', 0.35],
])

export function isRiderCloth(name: string): boolean {
  return clothUptake.has(name)
}

async function store(directory: string, bytes: Buffer, kind: 'color' | 'data'): Promise<string> {
  const file = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${kind}.webp`
  await writeFile(join(directory, file), bytes)
  return `/experiments/out-west/3d/native-v2/characters/${file}`
}

async function colors(name: string, image: Uint8Array, directory: string) {
  const cloth = isRiderCloth(name)
  const size = cloth ? 3072 : 768
  const { data: pixels, info } = await sharp(image)
    .resize(size, size, cloth ? { fit: 'inside', withoutEnlargement: true } : {})
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const input = { raw: { width: info.width, height: info.height, channels: 3 as const } }
  const encode = cloth ? { quality: 93, smartSubsample: true } : { quality: 91 }
  const albedo = await store(directory, await sharp(pixels, input).webp(encode).toBuffer(), 'color')
  const { channels } = await sharp(pixels, input).stats()
  const mean = Math.max(1, channels.reduce((sum, channel) => sum + channel.mean, 0) / 3)
  const strength = clothUptake.get(name) ?? 0.76
  const depth = isRiderCloth(name) ? Math.min(1.15, Math.max(0.42, mean / 154)) : 1
  const dyes: Record<string, string> = {}
  for (const dye of DYES) {
    if (!dye.hex) {
      continue
    }
    const target = Buffer.from(dye.hex.slice(1), 'hex')
    if (!cloth) {
      // Keep previously fitted hats and holsters on their original dye atlases.
      const tinted = Buffer.alloc(pixels.length)
      for (let i = 0; i < pixels.length; i += 3) {
        const light = ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0)) / (3 * mean)
        for (let lane = 0; lane < 3; lane++) {
          tinted[i + lane] = Math.min(
            255,
            Math.round(0.24 * (pixels[i + lane] ?? 0) + 0.76 * light * (target[lane] ?? 0)),
          )
        }
      }
      dyes[dye.id] = await store(
        directory,
        await sharp(tinted, input).webp(encode).toBuffer(),
        'color',
      )
      continue
    }
    const k = Array.from(target, (c) => (strength * depth * c) / (3 * mean))
    const [red = 0, green = 0, blue = 0] = k
    const base = 1 - strength
    const tinted = await sharp(pixels, input)
      .recomb([
        [red + base, red, red],
        [green, green + base, green],
        [blue, blue, blue + base],
      ])
      .webp(encode)
      .toBuffer()
    dyes[dye.id] = await store(directory, tinted, 'color')
  }
  return { albedo, dyes }
}

const colorCache = new Map<string, ReturnType<typeof colors>>()
const dataCache = new Map<string, Promise<string>>()

async function dataMap(directory: string, texture: Texture | null) {
  const bytes = texture?.getImage()
  if (!bytes) {
    return
  }
  const key = directory + createHash('sha256').update(bytes).digest('hex')
  let ready = dataCache.get(key)
  if (!ready) {
    ready = sharp(bytes)
      .webp({ lossless: true, effort: 2 })
      .toBuffer()
      .then((data) => store(directory, data, 'data'))
    dataCache.set(key, ready)
  }
  return await ready
}

export async function fabricDyes(material: Material, directory: string): Promise<void> {
  const name = material.getName()
  const image = material.getBaseColorTexture()?.getImage()
  if (!image) {
    throw new Error(`Missing photographed color for ${name}`)
  }
  await mkdir(directory, { recursive: true })
  const key = directory + name + createHash('sha256').update(image).digest('hex')
  let maps = colorCache.get(key)
  if (!maps) {
    maps = colors(name, image, directory)
    colorCache.set(key, maps)
  }
  const surface = await maps
  if (isRiderCloth(name)) {
    const [normal, arm] = await Promise.all([
      dataMap(directory, material.getNormalTexture()),
      dataMap(directory, material.getMetallicRoughnessTexture()),
    ])
    if (!(normal && arm)) {
      throw new Error(`Missing cloth relief or roughness for ${name}`)
    }
    material
      .setExtras({ nativePbr: { ...surface, normal, normalScale: material.getNormalScale(), arm } })
      .setNormalTexture(null)
      .setMetallicRoughnessTexture(null)
  } else {
    material.setExtras({ nativePbr: surface })
  }
  material.setBaseColorTexture(null).setName('Dyeable')
}
