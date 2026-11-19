import type { Document } from '@gltf-transform/core'
import sharp from 'sharp'

const TILE_SIZE = 128
const COURSES = [
  [0.28, 0.14, 0.055],
  [0.48, 0.24, 0.027],
  [0.67, 0.12, 0.065],
  [0.81, 0.16, 0.025],
] as const

function sandstoneTile() {
  const pixels = Buffer.alloc(TILE_SIZE * TILE_SIZE * 3)
  for (let row = 0; row < TILE_SIZE; row++) {
    const v = row / (TILE_SIZE - 1)
    for (let column = 0; column < TILE_SIZE; column++) {
      const phase = (column / TILE_SIZE) * 2 * Math.PI
      // Let the beds bend along the bluff without repeating a hard edge at the tile seam.
      const height =
        1 - v + 0.018 * Math.sin(2 * phase + 1.5 * v) + 0.009 * Math.sin(5 * phase - 3 * v)
      const shade = COURSES.reduce(
        (value, [center, depth, width]) =>
          value + depth * Math.exp(-(((height - center) / width) ** 2)),
        0,
      )
      const grain = 0.017 * Math.sin(13 * phase + 83 * v) * Math.sin(19 * phase - 71 * v)
      const tone = Math.min(1, Math.max(0.66, 0.99 - shade + grain))
      const offset = (row * TILE_SIZE + column) * 3
      pixels[offset] = Math.round(255 * tone)
      pixels[offset + 1] = Math.round(237 * tone)
      pixels[offset + 2] = Math.round(218 * tone)
    }
  }
  return sharp(pixels, { raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 3 } })
    .png()
    .toBuffer()
}

/** The distant bluff faces used the service props' canvas weave. Give rock its own height chart. */
export async function dressDuelBluffs(document: Document) {
  const node = document
    .getRoot()
    .listNodes()
    .find((item) => item.getName() === 'environment-19')
  const primitives = node?.getMesh()?.listPrimitives()
  const bluff = primitives?.[0]
  const positions = bluff?.getAttribute('POSITION')?.getArray()
  const uv = bluff?.getAttribute('TEXCOORD_0')
  if (
    !(
      bluff &&
      primitives?.length === 1 &&
      positions &&
      uv &&
      bluff.getMaterial()?.getName() === 'ambiance.canvas'
    )
  ) {
    throw new Error('Duel bluff source mesh changed')
  }

  const chart = new Float32Array((positions.length / 3) * 2)
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const x = positions[vertex * 3] ?? 0
    const y = positions[vertex * 3 + 1] ?? 0
    const z = positions[vertex * 3 + 2] ?? 0
    chart[vertex * 2] = (x + 0.625 * z) / 48
    chart[vertex * 2 + 1] = 1 - (y + 2) / 32
  }
  bluff.setAttribute('TEXCOORD_0', uv.clone().setArray(chart))
  const tile = document
    .createTexture('Distant strata')
    .setImage(await sandstoneTile())
    .setMimeType('image/png')
  const material = document
    .createMaterial('Distant sandstone')
    .setBaseColorTexture(tile)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.92)
  bluff.setMaterial(material)
}
