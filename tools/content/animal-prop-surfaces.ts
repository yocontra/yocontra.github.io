/** Offline surface authoring shared by animals, foliage and small Western props. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Document, Material, Primitive, Texture } from '@gltf-transform/core'
import { prune } from '@gltf-transform/functions'
import sharp from 'sharp'
import { compressedCharacterTexture } from './character-textures.ts'

export type Surface = 'fur' | 'feather' | 'straw' | 'bark' | 'cactus' | 'iron' | 'canvas'
const directory = 'tools/art/props/textures'
const cache = new Map<Surface, { albedo: Uint8Array; normal: Uint8Array; arm: Uint8Array }>()
const fract = (x: number) => x - Math.floor(x)
function heightAt(kind: Surface, x: number, y: number): number {
  const hash = fract(Math.sin(x * 127.1 + y * 311.7) * 43_758.5453)
  const stripe = (period: number, slant = 0) => Math.cos(((x + slant * y) * Math.PI * 2) / period)
  if (kind === 'canvas') {
    return 0.5 + 0.14 * stripe(4) + 0.14 * Math.cos((y * Math.PI) / 2) + 0.05 * hash
  }
  if (kind === 'iron') {
    return 0.5 + 0.05 * hash + 0.025 * stripe(64, 0.14)
  }
  if (kind === 'cactus') {
    return 0.45 + 0.22 * stripe(32) + 0.035 * hash + (x % 32 < 2 && y % 23 < 3 ? 0.12 : 0)
  }
  if (kind === 'bark') {
    return 0.5 + 0.17 * stripe(21, 0.08 * Math.sin(y / 32)) + 0.08 * stripe(7, 0.1) + 0.04 * hash
  }
  if (kind === 'straw') {
    return 0.5 + 0.2 * stripe(8, 0.16) + 0.1 * stripe(17, -0.1) + 0.04 * hash
  }
  if (kind === 'feather') {
    const shaft = (x % 64) - 32
    return (
      0.48 +
      0.15 * Math.cos((shaft * Math.PI) / 32) +
      0.08 * Math.cos(((y + Math.abs(shaft) * 0.7) * Math.PI) / 6) +
      0.02 * hash
    )
  }
  return (
    0.5 +
    0.13 * stripe(5, 0.23) * Math.sin((y * Math.PI) / 17) +
    0.07 * stripe(13, -0.1) +
    0.04 * hash
  )
}
/** Neutral albedo modulates existing semantic vertex colours; normals and ARM are linear. */
export async function surfaceImages(kind: Surface) {
  const previous = cache.get(kind)
  if (previous) {
    return previous
  }
  const size = 256
  const albedo = new Uint8Array(size * size * 4)
  const normal = new Uint8Array(size * size * 4)
  const arm = new Uint8Array(size * size * 4)
  const rough = {
    fur: 0.94,
    feather: 0.79,
    straw: 0.97,
    bark: 0.96,
    cactus: 0.89,
    iron: 0.58,
    canvas: 0.96,
  }[kind]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const h = heightAt(kind, x, y)
      const value = Math.round(218 + h * 35)
      albedo.set([value, value, value, 255], i)
      const strength = kind === 'iron' ? 0.45 : 0.8
      const dx =
        (heightAt(kind, (x + 1) % size, y) - heightAt(kind, (x + size - 1) % size, y)) * strength
      const dy =
        (heightAt(kind, x, (y + 1) % size) - heightAt(kind, x, (y + size - 1) % size)) * strength
      const length = Math.hypot(dx, dy, 1)
      normal.set(
        [
          Math.round(127.5 - (dx / length) * 127),
          Math.round(127.5 - (dy / length) * 127),
          Math.round(127.5 + 127 / length),
          255,
        ],
        i,
      )
      arm.set(
        [
          Math.round(235 + h * 20),
          Math.round(Math.min(1, rough + (h - 0.5) * 0.14) * 255),
          kind === 'iron' ? 220 : 0,
          255,
        ],
        i,
      )
    }
  }
  const encode = (bytes: Uint8Array) =>
    sharp(bytes, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toBuffer()
  const result = {
    albedo: await encode(albedo),
    normal: await encode(normal),
    arm: await encode(arm),
  }
  await mkdir(directory, { recursive: true })
  await Promise.all(
    Object.entries(result).map(([name, bytes]) =>
      writeFile(`${directory}/${kind}-${name}.png`, bytes),
    ),
  )
  cache.set(kind, result)
  return result
}
export async function surfaceMaterial(
  doc: Document,
  kind: Surface,
  name = `Western ${kind}`,
): Promise<Material> {
  const previous = doc
    .getRoot()
    .listMaterials()
    .find((m) => m.getName() === name)
  if (previous?.getBaseColorTexture()) {
    return previous
  }
  const images = await surfaceImages(kind)
  const image = (role: keyof typeof images) =>
    doc.createTexture(`${kind} ${role}`).setImage(images[role]).setMimeType('image/png')
  const arm = image('arm')
  return (previous ?? doc.createMaterial(name))
    .setBaseColorTexture(image('albedo'))
    .setNormalTexture(image('normal'))
    .setNormalScale(0.6)
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
    .setRoughnessFactor(1)
    .setMetallicFactor(kind === 'iron' ? 1 : 0)
}
/** Position projection is baked once, never a runtime shader or material customization. */
export function projectedUv(doc: Document, primitive: Primitive, repetitions = 4): void {
  const positions = primitive.getAttribute('POSITION')
  if (!positions) {
    return
  }
  const min = positions.getMin([])
  const max = positions.getMax([])
  const extent = Math.max(...max.map((v, i) => v - (min[i] ?? 0)), 0.001)
  const normals = primitive.getAttribute('NORMAL')
  const uv = new Float32Array(positions.getCount() * 2)
  for (let i = 0; i < positions.getCount(); i++) {
    const p = positions.getElement(i, [])
    const n = normals?.getElement(i, []) ?? [0, 0, 1]
    const ax = Math.abs(n[0] ?? 0)
    const ay = Math.abs(n[1] ?? 0)
    const az = Math.abs(n[2] ?? 0)
    let axes = [0, 1]
    if (ay > ax && ay > az) {
      axes = [0, 2]
    } else if (ax > az) {
      axes = [2, 1]
    }
    uv.set(
      axes.map((a) => (((p[a] ?? 0) - (min[a] ?? 0)) / extent) * repetitions),
      i * 2,
    )
  }
  primitive.setAttribute(
    'TEXCOORD_0',
    doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(positions.getBuffer()),
  )
}
export async function kitMaterial(doc: Document): Promise<Material> {
  const maps = await Promise.all(
    ['diff', 'nor', 'arm'].map(async (kind) =>
      doc
        .createTexture(`Kit ${kind}`)
        .setImage(await readFile(`public/experiments/out-west/3d/tex/kit_${kind}.webp`))
        .setMimeType('image/webp'),
    ),
  )
  const [albedo, normal, arm] = maps
  if (!(albedo && normal && arm)) {
    throw new Error('Missing Kit maps')
  }
  return doc
    .createMaterial('Western original Kit PBR')
    .setBaseColorTexture(albedo)
    .setNormalTexture(normal)
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
    .setNormalScale(0.7)
    .setRoughnessFactor(1)
    .setMetallicFactor(1)
}

export async function externalize(doc: Document) {
  for (const material of doc.getRoot().listMaterials()) {
    const base = material.getBaseColorTexture()
    const normal = material.getNormalTexture()
    const arm = material.getMetallicRoughnessTexture()
    if (!base?.getImage()) {
      continue
    }
    const encode = (texture: Texture | null, color: boolean) => {
      const image = texture?.getImage()
      return image ? compressedCharacterTexture(image, color, 'environments') : undefined
    }
    material.setExtras({
      ...material.getExtras(),
      nativePbr: {
        albedo: await encode(base, true),
        normal: await encode(normal, false),
        arm: await encode(arm, false),
        ao: Boolean(arm && material.getOcclusionTexture() === arm),
        aoUv: material.getOcclusionTextureInfo()?.getTexCoord() ?? 0,
        aoStrength: material.getOcclusionStrength(),
      },
    })
    material
      .setBaseColorTexture(null)
      .setNormalTexture(null)
      .setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null)
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }))
}
