/** Isolate the existing hanging lantern's glass UV island without modifying its shared atlas. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'

export const LANTERN_MASK = {
  size: 256,
  min: [0.25, 0.75],
  max: [0.375, 1],
  source: 'tools/art/environments/lantern-glow.png',
  public: 'public/experiments/out-west/3d/native-v2/ambient/lantern-glow.png',
} as const

export function lanternMask(): Promise<Buffer> {
  const { size, min, max } = LANTERN_MASK
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      const glass =
        x >= min[0] * size && x < max[0] * size && y >= min[1] * size && y < max[1] * size
      pixels.fill(glass ? 255 : 0, offset, offset + 3)
      pixels[offset + 3] = 255
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
}

export async function writeLanternMask() {
  const image = await lanternMask()
  for (const path of [LANTERN_MASK.source, LANTERN_MASK.public]) {
    await writeFile(path, image)
  }
  const hash = createHash('sha256').update(image).digest('hex')
  return {
    url: `${LANTERN_MASK.public.slice('public'.length)}?v=${hash.slice(0, 16)}`,
    bytes: image.byteLength,
    hash,
  }
}

if (import.meta.main) {
  console.log(await writeLanternMask())
}
