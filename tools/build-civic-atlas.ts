#!/usr/bin/env bun
/**
 * Build the clock tower's masonry atlas (`tex/civic_{diff,nor,arm}.webp`) from four CC0 Poly Haven
 * sets: red brick, dressed sandstone, roof slates and rusty sheet metal (see CREDITS.md).
 *
 *   bun tools/build-civic-atlas.ts [out_root]
 *
 * The atlas is 2x2 cells (scene/civic.ts `CIVIC_CELLS` names them). Each cell holds one tile of
 * its set plus a gutter of wrapped texels all round, so the runtime shader can `fract()` the
 * world-scale UV inside the cell and sample with `textureGrad` without bilinear or mip bleed at
 * the tile seam. Albedo is 1024² (480 px tiles); normal and ARM are 512² (240 px tiles), the
 * same UV fractions.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { CIVIC_GUTTER, CIVIC_SETS } from '../src/experiments/out-west/scene/civic-atlas.ts'

const [OUT = 'public/experiments/out-west/3d'] = process.argv.slice(2)

type Files = Record<string, Record<string, Record<string, { url: string }>>>

/** Poly Haven file keys per map, and the atlas size each map is written at. */
const MAPS = [
  { key: 'Diffuse', name: 'diff', size: 1024, q: 86 },
  { key: 'nor_gl', name: 'nor', size: 512, q: 92 },
  { key: 'arm', name: 'arm', size: 512, q: 92 },
] as const

async function source(files: Files, key: string): Promise<Buffer> {
  const entry = files[key]?.['1k']
  const url = entry?.jpg?.url ?? entry?.png?.url
  if (!url) {
    throw new Error(`no 1k ${key}`)
  }
  return Buffer.from(await (await fetch(url)).arrayBuffer())
}

/** One cell: the tile at `cell - 2 * gutter`, wrapped into the gutter on every side. */
async function cell(src: Buffer, cellPx: number): Promise<Buffer> {
  const g = Math.round(cellPx * CIVIC_GUTTER)
  const t = cellPx - g * 2
  const tile = await sharp(src).removeAlpha().resize(t, t, { fit: 'fill' }).png().toBuffer()
  const tiles: { input: Buffer; left: number; top: number }[] = []
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      tiles.push({ input: tile, left: x * t, top: y * t })
    }
  }
  const big = await sharp({
    create: { width: t * 3, height: t * 3, channels: 3, background: '#000' },
  })
    .composite(tiles)
    .png()
    .toBuffer()
  return sharp(big)
    .extract({ left: t - g, top: t - g, width: cellPx, height: cellPx })
    .png()
    .toBuffer()
}

async function main(): Promise<void> {
  const dir = join(OUT, 'tex')
  await mkdir(dir, { recursive: true })
  const sets: Files[] = []
  for (const s of CIVIC_SETS) {
    const res = await fetch(`https://api.polyhaven.com/files/${s.id}`)
    if (!res.ok) {
      throw new Error(`Poly Haven: ${s.id} not found (${res.status})`)
    }
    sets.push((await res.json()) as Files)
  }
  for (const m of MAPS) {
    const c = m.size / 2
    const parts: { input: Buffer; left: number; top: number }[] = []
    for (const [i, files] of sets.entries()) {
      const src = await source(files, m.key)
      // cell i: column i % 2, row floor(i / 2) from the top of the image
      parts.push({ input: await cell(src, c), left: (i % 2) * c, top: Math.floor(i / 2) * c })
    }
    const dest = join(dir, `civic_${m.name}.webp`)
    const info = await sharp({
      create: { width: m.size, height: m.size, channels: 3, background: '#000' },
    })
      .composite(parts)
      .webp({ quality: m.q, effort: 6 })
      .toFile(dest)
    console.log(`${dest}  ${m.size}²  ${(info.size / 1024).toFixed(0)} KB`)
  }
}

await main()
