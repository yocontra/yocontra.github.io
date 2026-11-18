import sharp from 'sharp'
import type { FrontierGeometry } from './frontier-geometry.ts'

export const SHAKE_TILE = { along: 2.2, slope: 1.76 }
const SIZE = 512
const COURSES = 8
const PER_COURSE = 9
const WOOD = 'public/experiments/out-west/3d/tex/vplanks_diff.webp'

function variation(row: number, shake: number, seed: number): number {
  let bits = Math.imul(row + 1, 0x12_06_49_9d) ^ Math.imul(shake + 1, 0x27_d4_eb_2d) ^ seed
  bits = Math.imul(bits ^ (bits >>> 15), 0x4_5d_9f_3b)
  return ((bits ^ (bits >>> 16)) >>> 0) / 0xff_ff_ff_ff
}

/** Shake widths and starting offsets repeat with the tile. Drainage runs along the wood grain. */
function courses() {
  return Array.from({ length: COURSES }, (_course, row) => {
    const widths = Array.from(
      { length: PER_COURSE },
      (_shake, shake) => 0.68 + variation(row, shake, 0),
    )
    const sum = widths.reduce((length, width) => length + width, 0)
    let end = 0
    return {
      offset: (row % 2) * 0.053 + 0.089 * variation(row, 0, 123),
      bounds: widths.map((width) => {
        const start = end
        end += width / sum
        return { start, end }
      }),
    }
  })
}

export async function authorRoofMaterial(g: FrontierGeometry) {
  const wood = await sharp(WOOD).resize(SIZE, SIZE).removeAlpha().raw().toBuffer()
  const paint = Buffer.alloc(SIZE * SIZE * 3)
  const heights = new Float32Array(SIZE * SIZE)
  for (const [row, { offset, bounds }] of courses().entries()) {
    for (let y = (row * SIZE) / COURSES; y < ((row + 1) * SIZE) / COURSES; y++) {
      const upslope = 1 - (((y * COURSES) / SIZE) % 1)
      for (let x = 0; x < SIZE; x++) {
        const across = (x / SIZE + offset) % 1
        const shake = bounds.findIndex((bound) => across < bound.end)
        const boundsForShake = bounds[shake]
        if (!boundsForShake) {
          throw new Error('Roof shake course does not cover its tile')
        }
        const { start, end } = boundsForShake
        const inside = (across - start) / (end - start)
        const widthPx = (end - start) * SIZE
        const butt = 0.014 * (variation(row, shake, 33) - 0.5)
        const joint = Math.min(inside, 1 - inside) * widthPx
        const exposed = Math.max(0, Math.min(1, (upslope + butt) * 24))
        const gain = 1.12 + variation(row, shake, 77) * 0.48
        const grainX = Math.floor(
          (0.21 * variation(row, shake, 111) + 0.078 * inside + 0.62) * SIZE,
        )
        const grainY = Math.floor(((variation(row, shake, 191) + upslope * 0.19) % 1) * SIZE)
        const donor = (grainY * SIZE + grainX) * 3
        const grain = wood[donor] ?? 0
        const pixel = y * SIZE + x
        const shadow = (0.63 + 0.37 * exposed) * (joint < 1.25 ? 0.59 : 1)
        for (let channel = 0; channel < 3; channel++) {
          paint[pixel * 3 + channel] = Math.min(
            255,
            Math.round((wood[donor + channel] ?? 0) * gain * shadow),
          )
        }
        const bevel = Math.min(joint / 2, 1)
        heights[pixel] = 0.012 * exposed * (1 - upslope * 0.72) * bevel + grain * 0.000_013
      }
    }
  }
  const normal = Buffer.alloc(paint.length)
  const heightAt = (x: number, y: number) =>
    heights[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)] ?? 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const east = (heightAt(x - 1, y) - heightAt(x + 1, y)) / ((2 * SHAKE_TILE.along) / SIZE)
      const up = (heightAt(x, y + 1) - heightAt(x, y - 1)) / ((2 * SHAKE_TILE.slope) / SIZE)
      const length = Math.hypot(east, up, 1)
      const pixel = (y * SIZE + x) * 3
      normal[pixel] = Math.round(127.5 * (1 + east / length))
      normal[pixel + 1] = Math.round(127.5 * (1 + up / length))
      normal[pixel + 2] = Math.round(127.5 * (1 + 1 / length))
    }
  }
  const texture = async (name: string, data: Buffer) =>
    g.doc
      .createTexture(name)
      .setMimeType('image/webp')
      .setImage(
        await sharp(data, { raw: { width: SIZE, height: SIZE, channels: 3 } })
          .webp({ lossless: true })
          .toBuffer(),
      )
  g.materials.set(
    'cedar-shakes',
    g.doc
      .createMaterial('Perdition weathered cedar shakes')
      .setBaseColorTexture(await texture('Staggered split cedar shakes', paint))
      .setNormalTexture(await texture('Lapped cedar bevel and grain', normal))
      .setMetallicFactor(0)
      .setRoughnessFactor(0.91),
  )
}
