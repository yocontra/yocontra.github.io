#!/usr/bin/env bun
/**
 * Make a generated texture tile seamlessly and write it as WebP:
 *
 *   bun tools/seamless.ts <in> <out.webp> [--size 512] [--band 0.25] [--q 80] [--preview out.png]
 *
 * Image generators don't produce true tiles. This cross-fades the image toward a copy of itself
 * offset by half its size: the centre keeps the original, the edges show the offset copy, whose
 * opposite edges are neighbours in the source, so the result wraps with no seam. `--band` is the
 * fraction of each side used for the fade. `--preview` writes a 2×2 tiling to check by eye.
 */
import { stat } from 'node:fs/promises'
import sharp from 'sharp'

interface Args {
  input: string
  output: string
  size: number | null
  band: number
  quality: number
  preview: string | null
}

function parse(argv: string[]): Args {
  const [input, output] = argv
  if (!(input && output)) {
    throw new Error('usage: bun tools/seamless.ts <in> <out.webp> [--size n] [--band f] [--q n]')
  }
  const flag = (k: string): string | null => {
    const i = argv.indexOf(k)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  const size = flag('--size')
  return {
    input,
    output,
    size: size ? Number(size) : null,
    band: Number(flag('--band') ?? '0.25'),
    quality: Number(flag('--q') ?? '80'),
    preview: flag('--preview'),
  }
}

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

const a = parse(process.argv.slice(2))
let img = sharp(a.input).removeAlpha()
if (a.size) {
  img = img.resize(a.size, a.size, { fit: 'cover', kernel: 'lanczos3' })
}
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
const { width: w, height: h, channels: ch } = info
const out = Buffer.alloc(data.length)
const bx = Math.max(1, Math.round(w * a.band))
const by = Math.max(1, Math.round(h * a.band))
for (let y = 0; y < h; y++) {
  const wy = smooth(Math.min(y, h - 1 - y) / by)
  const oy = (y + (h >> 1)) % h
  for (let x = 0; x < w; x++) {
    const m = smooth(Math.min(x, w - 1 - x) / bx) * wy
    const ox = (x + (w >> 1)) % w
    const i = (y * w + x) * ch
    const j = (oy * w + ox) * ch
    for (let c = 0; c < ch; c++) {
      out[i + c] = Math.round((data[i + c] ?? 0) * m + (data[j + c] ?? 0) * (1 - m))
    }
  }
}
const raw = { raw: { width: w, height: h, channels: ch } } as const
await sharp(out, raw).webp({ quality: a.quality, effort: 6 }).toFile(a.output)
if (a.preview) {
  const tile = await sharp(out, raw).png().toBuffer()
  await sharp({ create: { width: w * 2, height: h * 2, channels: 3, background: '#000' } })
    .composite([
      { input: tile, left: 0, top: 0 },
      { input: tile, left: w, top: 0 },
      { input: tile, left: 0, top: h },
      { input: tile, left: w, top: h },
    ])
    .png()
    .toFile(a.preview)
}
const { size } = await stat(a.output)
console.log(`${a.output}  ${w}×${h}  ${(size / 1024).toFixed(1)} KB`)
