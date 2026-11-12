/** Preserve original texel density and masked linear-light colors in native PBR images. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Accessor, Document, Primitive, Texture } from '@gltf-transform/core'
import sharp from 'sharp'
import { patchSkinAtlas } from './head-nape.ts'
export interface Range {
  start: number
  count: number
  name?: string
  slot?: string
  swatch?: string
}
export interface Pixels {
  data: Buffer
  width: number
  height: number
}
export interface Patch {
  range: Range
  indices: number[]
  x: number
  y: number
  width: number
  height: number
  left: number
  top: number
  lum: number
}
const output = resolve('public/experiments/out-west/3d/native-v2')
const linear = (value: number): number =>
  value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const gamma = (value: number): number =>
  Math.round(
    255 *
      Math.max(
        0,
        Math.min(1, value <= 0.003_130_8 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055),
      ),
  )
export const cache = new Map<Texture, Promise<Pixels>>()
export function pixels(texture: Texture): Promise<Pixels> {
  let promise = cache.get(texture)
  if (!promise) {
    const image = texture.getImage()
    if (!image) {
      throw new Error('Source material has no image')
    }
    promise = sharp(image)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(async ({ data, info }) => {
        const result = { data, width: info.width, height: info.height }
        await patchSkinAtlas(image, result)
        return result
      })
    cache.set(texture, promise)
  }
  return promise
}
export async function imageFile(
  data: Uint8Array,
  width: number,
  height: number,
  color: boolean,
): Promise<string> {
  const encoded = await sharp(data, { raw: { width, height, channels: 4 } })
    .webp({ quality: 95, lossless: !color })
    .toBuffer()
  const name = `${createHash('sha256').update(encoded).digest('hex').slice(0, 24)}.${color ? 'color' : 'data'}.webp`
  await writeFile(resolve(output, 'characters', name), encoded)
  return `/experiments/out-west/3d/native-v2/characters/${name}`
}
export async function originalFile(texture: Texture, color: boolean): Promise<string> {
  const image = await pixels(texture)
  return imageFile(image.data, image.width, image.height, color)
}
export function element(
  accessor: Accessor | null,
  index: number,
  size: number,
  fallback = 0,
): number[] {
  return accessor ? accessor.getElement(index, []) : Array.from({ length: size }, () => fallback)
}
export function rangeIndices(primitive: Primitive, range: Range): number[] {
  const input = primitive.getIndices()
  if (!input) {
    throw new Error('Canonical character requires indexed geometry')
  }
  const result: number[] = []
  for (let i = 0; i < input.getCount(); i += 3) {
    const triangle = [input.getScalar(i), input.getScalar(i + 1), input.getScalar(i + 2)]
    if (triangle.every((index) => index >= range.start && index < range.start + range.count)) {
      result.push(...triangle)
    }
  }
  return result
}
function sample(image: Pixels, u: number, v: number): number[] {
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(u * image.width)))
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(v * image.height)))
  const offset = (y * image.width + x) * 4
  return [
    image.data[offset] ?? 0,
    image.data[offset + 1] ?? 0,
    image.data[offset + 2] ?? 0,
    image.data[offset + 3] ?? 255,
  ]
}
export function appendPrimitive(
  doc: Document,
  original: Primitive,
  indices: number[],
  material: ReturnType<Document['createMaterial']>,
): Primitive {
  const primitive = doc.createPrimitive().setMaterial(material).setMode(original.getMode())
  for (const semantic of original.listSemantics()) {
    if (!semantic.startsWith('_')) {
      primitive.setAttribute(semantic, original.getAttribute(semantic))
    }
  }
  primitive.setIndices(
    doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint32Array(indices))
      .setBuffer(doc.getRoot().listBuffers()[0] ?? doc.createBuffer()),
  )
  return primitive
}
export function patches(
  primitive: Primitive,
  ranges: Range[],
  albedo: Pixels,
): { patches: Patch[]; width: number; height: number } {
  const uv = primitive.getAttribute('TEXCOORD_0')
  if (!uv) {
    throw new Error('Character atlas requires UVs')
  }
  const lum = primitive.getAttribute('_STYLE_LUMINANCE')
  const result: Patch[] = []
  for (const range of ranges) {
    const indices = rangeIndices(primitive, range)
    if (indices.length === 0) {
      continue
    }
    const used = [...new Set(indices)]
    const minimum = [1, 1]
    const maximum = [0, 0]
    for (const index of used) {
      const value = uv.getElement(index, [])
      for (let c = 0; c < 2; c++) {
        minimum[c] = Math.min(minimum[c] ?? 1, value[c] ?? 0)
        maximum[c] = Math.max(maximum[c] ?? 0, value[c] ?? 0)
      }
    }
    const left = Math.max(0, Math.floor((minimum[0] ?? 0) * albedo.width) - 1)
    const top = Math.max(0, Math.floor((minimum[1] ?? 0) * albedo.height) - 1)
    result.push({
      range,
      indices,
      x: 0,
      y: 0,
      left,
      top,
      width: Math.max(4, Math.ceil((maximum[0] ?? 1) * albedo.width) - left + 2),
      height: Math.max(4, Math.ceil((maximum[1] ?? 1) * albedo.height) - top + 2),
      lum: lum?.getScalar(used[0] ?? 0) ?? 0,
    })
  }
  // Shelf packing keeps every source texel; no character atlas is resized or stretched.
  result.sort((a, b) => b.height - a.height)
  const area = result.reduce((sum, p) => sum + (p.width + 4) * (p.height + 4), 0)
  const width = Math.max(
    512,
    2 ** Math.ceil(Math.log2(Math.max(...result.map((p) => p.width + 4), Math.sqrt(area)))),
  )
  let x = 2
  let y = 2
  let row = 0
  for (const p of result) {
    if (x + p.width + 2 > width) {
      x = 2
      y += row + 4
      row = 0
    }
    p.x = x
    p.y = y
    x += p.width + 4
    row = Math.max(row, p.height)
  }
  return { patches: result, width, height: Math.max(4, y + row + 2) }
}
export function renderPatch(
  p: Patch,
  primitive: Primitive,
  {
    images,
    atlases,
    width,
    dye,
  }: {
    images: { albedo: Pixels; normal: Pixels; arm: Pixels }
    atlases: { albedo: Uint8Array; normal: Uint8Array; arm: Uint8Array }
    width: number
    dye: string | null
  },
): void {
  const colors = primitive.getAttribute('COLOR_0')
  const style = primitive.getAttribute('_STYLE_MATERIAL')
  const dyeFactor = primitive.getAttribute('_DYE')
  const used = [...new Set(p.indices)]
  const color = element(colors, used[0] ?? 0, 3, 1)
  const rough = fabricRoughness(p.range, element(style, used[0] ?? 0, 2, 1)[0] ?? 1)
  const target = dye
    ? [
        linear(Number.parseInt(dye.slice(1, 3), 16) / 255),
        linear(Number.parseInt(dye.slice(3, 5), 16) / 255),
        linear(Number.parseInt(dye.slice(5, 7), 16) / 255),
      ]
    : null
  const factors = element(dyeFactor, used[0] ?? 0, 3)
  function put(x: number, y: number, tint: number[], r: number): void {
    const su = (p.left + x + 0.5) / images.albedo.width
    const sv = (p.top + y + 0.5) / images.albedo.height
    const base = sample(images.albedo, su, sv)
    const normal = fabricNormal(p.range, sample(images.normal, su, sv))
    const arm = sample(images.arm, su, sv)
    const rgb = base.slice(0, 3).map((value) => linear(value / 255))
    const luminance = (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722
    const mask = (arm[0] ?? 0) / 255
    const offset = ((p.y + y) * width + p.x + x) * 4
    for (let channel = 0; channel < 3; channel++) {
      const input = rgb[channel] ?? 0
      const value =
        p.lum > 0
          ? input * (1 - mask) +
            (tint[channel] ?? 1) * Math.min(luminance / Math.max(0.001, p.lum), 1.7) * mask
          : input * (tint[channel] ?? 1)
      atlases.albedo[offset + channel] = gamma(value)
      atlases.normal[offset + channel] = normal[channel] ?? 128
    }
    atlases.albedo[offset + 3] = 255
    atlases.normal[offset + 3] = 255
    atlases.arm.set(
      [255, Math.max(10, Math.min(255, Math.round((arm[1] ?? 255) * r))), arm[2] ?? 0, 255],
      offset,
    )
  }
  const tinted =
    target && factors.some((value) => value > 0)
      ? factors.map((value, c) => value * (target[c] ?? 1))
      : color
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      put(x, y, tinted, rough)
    }
  }
  // Preserve authored per-vertex lapel, cuff, leather and fabric variation in the baked map.
  for (let i = 0; i < p.indices.length; i += 3) {
    rasterTriangle({ p, primitive, albedo: images.albedo, target, put }, p.indices.slice(i, i + 3))
  }
}
interface Raster {
  p: Patch
  primitive: Primitive
  albedo: Pixels
  target: number[] | null
  put: (x: number, y: number, tint: number[], rough: number) => void
}
function rasterTriangle({ p, primitive, albedo, target, put }: Raster, indices: number[]): void {
  const uv = primitive.getAttribute('TEXCOORD_0')
  if (!uv) {
    return
  }
  const colors = primitive.getAttribute('COLOR_0')
  const style = primitive.getAttribute('_STYLE_MATERIAL')
  const dyeFactor = primitive.getAttribute('_DYE')
  const points = indices.map((index): [number, number] => {
    const value = uv.getElement(index, [])
    return [(value[0] ?? 0) * albedo.width - p.left, (value[1] ?? 0) * albedo.height - p.top]
  })
  const [a, b, c] = points
  if (!(a && b && c)) {
    return
  }
  const determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
  if (Math.abs(determinant) < 0.001) {
    return
  }
  const cs = indices.map((index) => {
    const factor = element(dyeFactor, index, 3)
    return target && factor.some((value) => value > 0)
      ? factor.map((value, k) => value * (target[k] ?? 1))
      : element(colors, index, 3, 1)
  })
  const rs = indices.map((index) => fabricRoughness(p.range, element(style, index, 2, 1)[0] ?? 1))
  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))) - 1)
  const maxX = Math.min(p.width - 1, Math.ceil(Math.max(...points.map((point) => point[0]))) + 1)
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))) - 1)
  const maxY = Math.min(p.height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))) + 1)
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const u = ((b[1] - c[1]) * (x + 0.5 - c[0]) + (c[0] - b[0]) * (y + 0.5 - c[1])) / determinant
      const v = ((c[1] - a[1]) * (x + 0.5 - c[0]) + (a[0] - c[0]) * (y + 0.5 - c[1])) / determinant
      const w = 1 - u - v
      if (Math.min(u, v, w) < -0.015) {
        continue
      }
      put(
        x,
        y,
        [0, 1, 2].map((k) => (cs[0]?.[k] ?? 1) * u + (cs[1]?.[k] ?? 1) * v + (cs[2]?.[k] ?? 1) * w),
        (rs[0] ?? 1) * u + (rs[1] ?? 1) * v + (rs[2] ?? 1) * w,
      )
    }
  }
}

/** Linen stays diffuse and worn leather keeps a broad highlight instead of plastic gloss. */
function fabricRoughness(range: Range, roughness: number): number {
  const scale = range.swatch === 'linen' ? 1.32 : 1
  const leather = range.swatch === 'leather' ? 1.15 : 1
  return roughness * scale * leather
}

/** Old wool normals carried deep apron folds; the fitted cloth keeps a gentler relief. */
function fabricNormal(range: Range, normal: number[]): number[] {
  if (range.name !== 'Waistcoat') {
    return normal
  }
  const x = ((normal[0] ?? 128) / 127.5 - 1) * 0.35
  const y = ((normal[1] ?? 128) / 127.5 - 1) * 0.35
  const z = (normal[2] ?? 255) / 127.5 - 1
  const length = Math.hypot(x, y, z) || 1
  return [x, y, z].map((value) => Math.round((value / length + 1) * 127.5))
}
