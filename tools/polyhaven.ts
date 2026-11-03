#!/usr/bin/env bun
/**
 * Fetch a Poly Haven (CC0) PBR texture set and write web-ready WebP maps.
 *
 *   bun tools/polyhaven.ts <asset_id> <out_dir> [--res 1k] [--maps diff,nor_gl,arm] [--name ground] [--q 82]
 *
 * Writes `<name>_<map>.webp` (map = diff | nor | arm | rough | ao | disp).
 * `arm` packs AO (R), roughness (G) and metalness (B): three.js reads it as
 * `aoMap` (R) plus `roughnessMap`/`metalnessMap` (G/B) from one texture.
 * Normal maps are the OpenGL (+Y) flavour that three.js expects.
 * Requires `cwebp` (brew install webp). Add the asset to CREDITS.md (CC0).
 */
import { spawnSync } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Args {
  id: string
  out: string
  res: string
  maps: string[]
  name: string
  quality: number
}

function parse(argv: string[]): Args {
  const [id, out] = argv
  if (!(id && out)) {
    throw new Error(
      'usage: bun tools/polyhaven.ts <asset_id> <out_dir> [--res 1k] [--maps diff,nor_gl,arm] [--name n] [--q 82]',
    )
  }
  const flag = (k: string, d: string) => {
    const i = argv.indexOf(k)
    return i >= 0 ? (argv[i + 1] ?? d) : d
  }
  return {
    id,
    out,
    res: flag('--res', '1k'),
    maps: flag('--maps', 'diff,nor_gl,arm').split(','),
    name: flag('--name', id),
    quality: Number(flag('--q', '82')),
  }
}

/** Poly Haven's file-list keys for each short map name. */
const KEYS: Record<string, string> = {
  diff: 'Diffuse',
  nor_gl: 'nor_gl',
  arm: 'arm',
  rough: 'Rough',
  ao: 'AO',
  disp: 'Displacement',
}

type Files = Record<string, Record<string, Record<string, { url: string }>>>

async function fetchMap(a: Args, files: Files, m: string): Promise<void> {
  const key = KEYS[m] ?? m
  const entry = files[key]?.[a.res]
  const url = entry?.png?.url ?? entry?.jpg?.url
  if (!url) {
    console.warn(`skip ${m}: no ${a.res} file`)
    return
  }
  const tmp = join(a.out, `.${a.name}_${m}.src`)
  await writeFile(tmp, new Uint8Array(await (await fetch(url)).arrayBuffer()))
  const short = m === 'nor_gl' ? 'nor' : m
  const dest = join(a.out, `${a.name}_${short}.webp`)
  // data maps (normal, ARM) get a higher quality than colour
  const q = m === 'diff' ? a.quality : Math.min(100, a.quality + 8)
  const p = spawnSync('cwebp', ['-quiet', '-q', String(q), '-m', '6', tmp, '-o', dest])
  await rm(tmp)
  if (p.status !== 0) {
    throw new Error(`cwebp failed for ${m}: ${p.stderr.toString()}`)
  }
  console.log(`${dest}  ${((await stat(dest)).size / 1024).toFixed(0)} KB  <- ${url}`)
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2))
  const res = await fetch(`https://api.polyhaven.com/files/${a.id}`)
  if (!res.ok) {
    throw new Error(`Poly Haven: ${a.id} not found (${res.status})`)
  }
  const files = (await res.json()) as Files
  await mkdir(a.out, { recursive: true })
  await Promise.all(a.maps.map((m) => fetchMap(a, files, m)))
}

await main()
