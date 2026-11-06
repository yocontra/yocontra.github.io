/**
 * Generate the phone texture set: a half-size WebP beside every full map
 * (`scene/textures.ts` reads `-half.webp` on the floor and legacy tiers). The full set is ~2.7 MB;
 * the half set is ~550 KB, which is the difference between a fast first load and a slow one on
 * mobile data. Run it after rebuilding the textures.
 *
 *   bun tools/half-textures.ts
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const DIR = 'public/experiments/out-west/3d/tex'
const MIN = 128

const files = await readdir(DIR)
let made = 0
for (const file of files) {
  if (!file.endsWith('.webp') || file.includes('-half')) {
    continue
  }
  const from = join(DIR, file)
  const meta = await sharp(from).metadata()
  const width = Math.max(1, Math.round((meta.width ?? 0) / 2))
  const height = Math.max(1, Math.round((meta.height ?? 0) / 2))
  if (width < MIN || height < MIN) {
    continue
  }
  const to = join(DIR, file.replace(/\.webp$/u, '-half.webp'))
  const quality = file.includes('_diff') ? 82 : 78
  await sharp(from).resize(width, height, { fit: 'fill' }).webp({ quality, effort: 5 }).toFile(to)
  const before = (await stat(from)).size
  const after = (await stat(to)).size
  console.log(
    `${file}: ${width}x${height} ${Math.round(before / 1024)}K -> ${Math.round(after / 1024)}K`,
  )
  made++
}
console.log(`half-textures: ${made} written`)
