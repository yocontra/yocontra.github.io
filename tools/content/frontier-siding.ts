import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { FrontierGeometry, Rgb } from './frontier-geometry.ts'

const SOURCE = 'public/experiments/out-west/3d/tex/vplanks_diff.webp'

export function isSidingTexture(name: string): boolean {
  return name.startsWith('Weathered ') && name.endsWith(' siding')
}

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/** Periodic noise keeps the wood boards and their worn finish seamless across wall spans. */
function grain(
  x: number,
  y: number,
  [columns, rows]: readonly [number, number],
  seed: number,
): number {
  const xx = x * columns
  const yy = y * rows
  const u = Math.floor(xx)
  const v = Math.floor(yy)
  const cell = (ix: number, iy: number) => {
    let bits =
      Math.imul((ix % columns) + seed, 0x4_5d_9f_3b) ^ Math.imul((iy % rows) + 1, 0x11_9d_e1_f3)
    bits = Math.imul(bits ^ (bits >>> 16), 0x4_5d_9f_3b)
    return ((bits ^ (bits >>> 16)) >>> 0) / 0xff_ff_ff_ff
  }
  const mix = (a: number, b: number, amount: number) => a + (b - a) * amount
  const top = mix(cell(u, v), cell(u + 1, v), smooth(xx - u))
  const bottom = mix(cell(u, v + 1), cell(u + 1, v + 1), smooth(xx - u))
  return mix(top, bottom, smooth(yy - v))
}

function linear(value: number): number {
  return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function srgb(value: number): number {
  return value <= 0.003_130_8 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
}

/** A thin paint coat, chalked boards and bare timber at the chips all share the scan's grain. */
export async function frontierSiding(g: FrontierGeometry, paints: ReadonlyMap<string, Rgb>) {
  const wood = g.materials.get('wood')
  if (!wood) {
    throw new Error('Frontier siding requires the authored wood PBR material')
  }
  const { data, info } = await sharp(await readFile(SOURCE))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const palette = Array.from({ length: 256 }, (_, index) => linear(index / 255))

  for (const [id, paint] of paints) {
    const seed = Array.from(id).reduce((hash, character) => hash * 31 + character.charCodeAt(0), 7)
    const pixels = Buffer.alloc(data.length)
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const x = column / width
        const y = row / height
        // Long flakes split along the grain in patches, with smaller scuffs between patches.
        const exposure = grain(x, y, [10, 5], seed)
        const flake = grain(x, y, [87, 33], seed + 2)
        const wear = 0.49 * flake + 0.33 * exposure + 0.18 * grain(x, y, [39, 11], seed + 3)
        const bare = smooth((wear - 0.55) / 0.18) * 0.92
        const chalk = 0.07 + exposure * 0.24
        const offset = (row * width + column) * channels
        for (let channel = 0; channel < channels; channel++) {
          const timber = palette[data[offset + channel] ?? 0] ?? 0
          const color = paint[channel] ?? 1
          const coat = color + (0.72 - color) * chalk
          const reflected = timber * (coat * (1 - bare) + bare * 0.82)
          pixels[offset + channel] = Math.round(srgb(reflected) * 255)
        }
      }
    }
    const texture = g.doc
      .createTexture(`Weathered ${id} siding`)
      .setImage(await sharp(pixels, { raw: info }).webp({ quality: 89 }).toBuffer())
      .setMimeType('image/webp')
    g.materials.set(
      `siding:${id}`,
      wood.clone().setName(`Perdition ${id} painted siding`).setBaseColorTexture(texture),
    )
  }
}
