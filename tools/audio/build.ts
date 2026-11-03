// biome-ignore-all lint/performance/useTopLevelRegex: ffmpeg log parsing, run once per file
// biome-ignore-all lint/style/useNamedCaptureGroup: one-number captures from ffmpeg logs
/**
 * Build the shipped out west 3D audio from `recipes.ts`.
 *
 *   bun tools/audio/build.ts            # everything
 *   bun tools/audio/build.ts rev_close fuse
 *
 * Masters each sound to its loudness target with true peak ≤ −1 dBTP (measured after AAC
 * encoding), writes `public/experiments/out-west/3d/<out>`, and regenerates the loop points the
 * engine needs (`src/experiments/out-west/audio/loop-points.ts`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Ch, master, type Packed, secs } from './dsp.ts'
import { RECIPES } from './recipes.ts'

const ROOT = resolve(import.meta.dir, '../..')
const PUB = resolve(ROOT, 'public/experiments/out-west/3d')
const POINTS = resolve(ROOT, 'src/experiments/out-west/audio/loop-points.ts')

interface Point {
  start: number
  end: number
}

function readPoints(): Record<string, Point> {
  if (!existsSync(POINTS)) {
    return {}
  }
  const out: Record<string, Point> = {}
  const re = /^ {2}(\w+): \{ start: ([\d.]+), end: ([\d.]+) \},$/gmu
  for (const m of readFileSync(POINTS, 'utf8').matchAll(re)) {
    out[m[1] ?? ''] = { start: Number(m[2]), end: Number(m[3]) }
  }
  return out
}

function writePoints(points: Record<string, Point>): void {
  const keys = Object.keys(points).sort((a, b) => a.localeCompare(b))
  const body = keys
    .map(
      (k) =>
        `  ${k}: { start: ${Number(points[k]?.start.toFixed(5))}, end: ${Number(points[k]?.end.toFixed(5))} },`,
    )
    .join('\n')
  writeFileSync(
    POINTS,
    `/**\n * Loop points (seconds into each file) written by \`tools/audio/build.ts\`. Do not edit by hand.\n * Each looped file is [lead-in | body | the body's first seconds again], so a streamed deck can\n * crossfade from \`end\` back to \`start\` over identical audio.\n */\nexport const LOOP_POINTS = {\n${body}\n} as const satisfies Record<string, { start: number; end: number }>\n`,
  )
}

const isPacked = (x: Ch | Packed): x is Packed => !Array.isArray(x)

function main(): void {
  const only = process.argv.slice(2)
  const ids = only.length > 0 ? only : Object.keys(RECIPES)
  const points = readPoints()
  const rows: string[] = []
  for (const id of ids) {
    const r = RECIPES[id]
    if (!r) {
      console.error(`unknown recipe ${id}`)
      process.exit(1)
    }
    const made = r.make()
    const ch = isPacked(made) ? made.ch : made
    if (isPacked(made)) {
      points[id] = { start: made.loopStart, end: made.loopEnd }
    }
    const out = resolve(PUB, r.out)
    mkdirSync(dirname(out), { recursive: true })
    const kbps = r.kbps ?? (ch.length > 1 ? 112 : 96)
    const e = master(ch, out, r.lufs, r.maxGR ?? 1.5, kbps)
    const row = `${id.padEnd(15)} ${r.out.padEnd(26)} ch${ch.length} ${secs(ch).toFixed(2).padStart(7)}s ${(e.bytes / 1024).toFixed(0).padStart(5)}KB  ${e.lufs.toFixed(1).padStart(6)} LUFS (target ${r.lufs})  ${e.tp.toFixed(1).padStart(5)} dBTP  gain ${e.gainDb.toFixed(1)}  lim ${e.limitDb.toFixed(1)}`
    console.log(row)
    rows.push(row)
  }
  writePoints(points)
}

if (import.meta.main) {
  main()
}
