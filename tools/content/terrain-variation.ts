/** Bake a larger seamless dirt tile without changing the normal material or adding runtime samplers. */
import type { Accessor, Document, Material, Texture } from '@gltf-transform/core'
import sharp from 'sharp'

const GRID = 4
const TILE_PIXELS = 320
const SIZE = TILE_PIXELS * GRID
const PHASES = [
  [0.02, 0.31],
  [0.39, 0.76],
  [0.67, 0.11],
  [0.88, 0.53],
  [0.82, 0.89],
  [0.14, 0.47],
  [0.58, 0.63],
  [0.34, 0.14],
  [0.52, 0.57],
  [0.91, 0.2],
  [0.08, 0.94],
  [0.72, 0.35],
  [0.28, 0.08],
  [0.63, 0.42],
  [0.47, 0.83],
  [0.19, 0.66],
] as const

function phase(tileX: number, tileY: number) {
  const value = PHASES[(tileY % GRID) * GRID + (tileX % GRID)]
  if (!value) {
    throw new Error('Missing terrain tile phase')
  }
  return value
}

function axis(pixel: number) {
  const scaled = pixel / TILE_PIXELS
  const tile = Math.floor(scaled)
  const local = scaled - tile
  const t = Math.max(0, (local - 0.68) / 0.32)
  return { tile, local, mix: t * t * (3 - 2 * t) }
}

interface BakedPixels {
  data: Buffer
  width: number
  height: number
}

function sample(pixels: BakedPixels, x: number, y: number, offset: readonly [number, number]) {
  // Phase shifts use the same UV in every PBR channel. Normals need no axis rotation.
  const px = Math.floor((x + offset[0]) * pixels.width) % pixels.width
  const py = Math.floor((y + offset[1]) * pixels.height) % pixels.height
  return (py * pixels.width + px) * 3
}

async function broadPattern(input: Uint8Array) {
  const { data, info } = await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({
    resolveWithObject: true,
  })
  if (info.channels !== 3) {
    throw new Error('Ground map must have three channels')
  }
  const pixels = { data, width: info.width, height: info.height }
  const coordinates = Array.from({ length: SIZE }, (_, pixel) => axis(pixel))
  const output = Buffer.alloc(SIZE * SIZE * 3)
  for (const [y, row] of coordinates.entries()) {
    for (const [x, column] of coordinates.entries()) {
      const { tile: i, local: u, mix: a } = column
      const { tile: j, local: v, mix: b } = row
      const topLeft = sample(pixels, u, v, phase(i, j))
      const topRight = sample(pixels, u, v, phase(i + 1, j))
      const bottomLeft = sample(pixels, u, v, phase(i, j + 1))
      const bottomRight = sample(pixels, u, v, phase(i + 1, j + 1))
      const destination = (y * SIZE + x) * 3
      for (let channel = 0; channel < 3; channel++) {
        const get = (index: number) => data[index + channel] ?? 0
        const top = get(topLeft) * (1 - a) + get(topRight) * a
        const bottom = get(bottomLeft) * (1 - a) + get(bottomRight) * a
        output[destination + channel] = Math.round(top * (1 - b) + bottom * b)
      }
    }
  }
  return sharp(output, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer()
}

async function variedGroundMaps(doc: Document, material: Material) {
  const options = [
    [material.getBaseColorTexture(), (texture: Texture) => material.setBaseColorTexture(texture)],
    [material.getNormalTexture(), (texture: Texture) => material.setNormalTexture(texture)],
    [
      material.getMetallicRoughnessTexture(),
      (texture: Texture) => material.setMetallicRoughnessTexture(texture),
    ],
    [material.getOcclusionTexture(), (texture: Texture) => material.setOcclusionTexture(texture)],
  ] as const
  const replacements = new Map<Texture, Texture>()
  for (const [source, set] of options) {
    const image = source?.getImage()
    if (!(source && image)) {
      continue
    }
    let texture = replacements.get(source)
    if (!texture) {
      texture = doc
        .createTexture(`Terrain variation ${source.getName()}`)
        .setImage(await broadPattern(image))
        .setMimeType('image/webp')
      replacements.set(source, texture)
    }
    set(texture)
  }
}

export async function installTerrainVariation(doc: Document, materialName: string): Promise<void> {
  const material = doc
    .getRoot()
    .listMaterials()
    .find((entry) => entry.getName() === materialName)
  if (!material) {
    throw new Error(`Missing terrain material ${materialName}`)
  }
  await variedGroundMaps(doc, material)
  const replacements = new Map<Accessor, Accessor>()
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMaterial() !== material) {
        continue
      }
      const uv = primitive.getAttribute('TEXCOORD_0')
      const data = uv?.getArray()
      if (!(uv && data instanceof Float32Array)) {
        throw new Error(`Expected float terrain UVs on ${mesh.getName()}`)
      }
      let scaled = replacements.get(uv)
      if (!scaled) {
        scaled = uv.clone().setArray(data.map((value) => value / GRID))
        replacements.set(uv, scaled)
      }
      primitive.setAttribute('TEXCOORD_0', scaled)
    }
  }
  if (replacements.size === 0) {
    throw new Error(`Missing terrain faces for ${materialName}`)
  }
}

function smooth(t: number) {
  return t * t * (3 - 2 * t)
}

function soilNoise(x: number, z: number) {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const u = smooth(x - ix)
  const v = smooth(z - iz)
  const sample = (dx: number, dz: number) => {
    let hash = Math.imul(ix + dx + 531, 0x4_5d_9f_3b) ^ Math.imul(iz + dz, 0x11_9d_e1_f3)
    hash = Math.imul(hash ^ (hash >>> 16), 0x4_5d_9f_3b)
    return ((hash ^ (hash >>> 16)) >>> 0) / 0xff_ff_ff_ff
  }
  const top = sample(0, 0) * (1 - u) + sample(1, 0) * u
  const bottom = sample(0, 1) * (1 - u) + sample(1, 1) * u
  return top * (1 - v) + bottom * v
}

/** Grey mineral dust and darker packed soil use site coordinates instead of the dirt tile. */
export function weatherPerditionSoil(doc: Document, size: number): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMaterial()?.getName() !== 'Perdition ground') {
        continue
      }
      const positions = primitive.getAttribute('POSITION')
      const colors = primitive.getAttribute('COLOR_0')
      if (!(positions && colors) || positions.getCount() !== colors.getCount()) {
        throw new Error('Missing vertex tint on the Perdition dirt')
      }
      const tint = colors.clone()
      const point = [0, 0, 0]
      const color = [0, 0, 0, 0]
      for (let i = 0; i < positions.getCount(); i++) {
        positions.getElement(i, point)
        colors.getElement(i, color)
        const [x = 0, , z = 0] = point
        const edge = Math.max(0, Math.min(1, Math.min(x, z, size - x, size - z) / 5))
        const drifts = soilNoise(x / 7.3, z / 4.6) * 2 - 1
        const dust = soilNoise((x + 11) / 2.5, (z - 8) / 1.7) * 2 - 1
        const lighter = Math.max(0, drifts)
        const density = edge * (drifts * 0.28 + dust * 0.085)
        for (let channel = 0; channel < 3; channel++) {
          const variation = density + channel * edge * lighter * 0.075
          color[channel] = Math.min(1, Math.max(0, (color[channel] ?? 0) * (1 + variation)))
        }
        tint.setElement(i, color)
      }
      primitive.setAttribute('COLOR_0', tint)
    }
  }
}
