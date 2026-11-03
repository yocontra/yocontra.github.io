#!/usr/bin/env bun
/**
 * Build out west's self-hosted web fonts: `bun tools/build-fonts.ts`.
 *
 * Writes latin-subset WOFF2 files to `public/experiments/out-west/fonts/` (stable URLs, so the
 * pages can preload them). Needs fontTools with brotli (`pip install fonttools brotli`); set
 * `FONTTOOLS_PY` to a python that has both (default `python3`).
 *
 * Why not the fontsource packages: their latin files drop the OpenType features the type system
 * relies on. EB Garamond loses `smcp`, `c2sc`, `onum` and `lnum`, so every small-caps label was
 * synthesized by the browser (shrunken capitals with thin stems). Oswald has no `tnum` at all and
 * proportional digits, so HUD money and timers jittered as they counted. Here:
 *
 * - EB Garamond (OFL, Georg Duffner / Octavio Pardo): variable `wght` clamped to 400–700, roman and
 *   italic, every layout feature kept.
 * - Oswald (OFL, Vernon Adams et al.): static 500 and 600 instances whose digits are re-spaced to a
 *   common advance (the zero's) and centred, so figures are tabular by default.
 * - Ultra (Apache 2.0, Astigmatic) and Rye (OFL, Nicole Fally): latin subsets, no hinting.
 *
 * Sources are fetched from github.com/google/fonts into node_modules/.cache/ow-fonts.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CACHE = join(ROOT, 'node_modules/.cache/ow-fonts')
const OUT = join(ROOT, 'public/experiments/out-west/fonts')
const PY = process.env.FONTTOOLS_PY ?? 'python3'
const GF = 'https://raw.githubusercontent.com/google/fonts/main'

/** Basic Latin, Latin-1 and the punctuation, arrows and maths signs the UI prints. */
const UNICODES = [
  'U+0020-007E',
  'U+00A0-00FF',
  'U+0131',
  'U+0152-0153',
  'U+02C6',
  'U+02DA',
  'U+02DC',
  'U+2013-2014',
  'U+2018-201A',
  'U+201C-201E',
  'U+2020-2022',
  'U+2026',
  'U+2030',
  'U+2039-203A',
  'U+2044',
  'U+20AC',
  'U+2122',
  'U+2190-2193',
  'U+2212',
  'U+2264-2265',
].join(',')

/**
 * The text face keeps what the UI asks for (small caps, figure styles, fractions, case-sensitive
 * forms, ligatures, kerning and marks) and drops swashes, stylistic sets and historical forms,
 * which are most of its weight.
 */
const TEXT_FEATURES = [
  'kern',
  'mark',
  'mkmk',
  'ccmp',
  'locl',
  'liga',
  'clig',
  'calt',
  'rlig',
  'smcp',
  'c2sc',
  'case',
  'onum',
  'lnum',
  'pnum',
  'tnum',
  'frac',
  'numr',
  'dnom',
].join(',')

interface Source {
  file: string
  url: string
}

const SRC = {
  // biome-ignore lint/security/noSecrets: a public Google Fonts file URL (the %5B…%5D is an encoded [wght]), not a secret
  garamond: { file: 'EBGaramond[wght].ttf', url: `${GF}/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf` },
  garamondItalic: {
    file: 'EBGaramond-Italic[wght].ttf',
    url: `${GF}/ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf`,
  },
  oswald: { file: 'Oswald[wght].ttf', url: `${GF}/ofl/oswald/Oswald%5Bwght%5D.ttf` },
  ultra: { file: 'Ultra-Regular.ttf', url: `${GF}/apache/ultra/Ultra-Regular.ttf` },
  rye: { file: 'Rye-Regular.ttf', url: `${GF}/ofl/rye/Rye-Regular.ttf` },
} satisfies Record<string, Source>

function run(cmd: string, args: string[]): string {
  const p = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (p.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\n${p.stderr}`)
  }
  return p.stdout
}

const fonttools = (...args: string[]): string => run(PY, ['-m', 'fontTools', ...args])

async function fetchSource(s: Source): Promise<string> {
  const path = join(CACHE, s.file)
  const have = await stat(path).catch(() => null)
  if (!have) {
    const r = await fetch(s.url)
    if (!r.ok) {
      throw new Error(`${s.url}: ${r.status}`)
    }
    await writeFile(path, new Uint8Array(await r.arrayBuffer()))
  }
  return path
}

async function subset(input: string, out: string, features = '*'): Promise<void> {
  fonttools(
    'subset',
    input,
    `--unicodes=${UNICODES}`,
    `--layout-features=${features}`,
    '--flavor=woff2',
    '--no-hinting',
    '--desubroutinize',
    '--name-IDs=0,1,2,3,4,5,6',
    `--output-file=${out}`,
  )
  const { size } = await stat(out)
  console.log(`${out.slice(ROOT.length + 1)}  ${(size / 1024).toFixed(1)} KB`)
}

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const PT_X = /<pt x="(?<x>-?\d+)"/gu
const X_MIN = /xMin="(?<v>-?\d+)"/u
const X_MAX = /xMax="(?<v>-?\d+)"/u

/** Shift one glyph's TTX element right by `dx` (its bounds and every point). */
function shiftGlyph(glyph: string, dx: number): string {
  return glyph
    .replace(X_MIN, (_m, v: string) => `xMin="${Number(v) + dx}"`)
    .replace(X_MAX, (_m, v: string) => `xMax="${Number(v) + dx}"`)
    .replace(PT_X, (_m, x: string) => `<pt x="${Number(x) + dx}"`)
}

const mtx = (g: string): RegExp =>
  new RegExp(`<mtx name="${g}" width="(?<width>\\d+)" lsb="(?<lsb>-?\\d+)"/>`, 'u')

/**
 * Give the ten digits one advance (the widest's) and centre each in it, by editing a TTX dump of
 * `glyf` and `hmtx` (absolute point coordinates there) and merging it back.
 */
async function tabularDigits(ttf: string): Promise<void> {
  const ttx = `${ttf}.ttx`
  fonttools('ttx', '-q', '-o', ttx, '-t', 'glyf', '-t', 'hmtx', ttf)
  let xml = await readFile(ttx, 'utf8')
  const widths = DIGITS.map((g) => Number(mtx(g).exec(xml)?.groups?.width ?? Number.NaN))
  if (widths.some(Number.isNaN)) {
    throw new Error(`no hmtx for a digit in ${ttf}`)
  }
  const target = Math.max(...widths)
  DIGITS.forEach((g, i) => {
    const dx = Math.round((target - (widths[i] ?? target)) / 2)
    xml = xml.replace(
      mtx(g),
      (_m, _w: string, lsb: string) =>
        `<mtx name="${g}" width="${target}" lsb="${Number(lsb) + dx}"/>`,
    )
    xml = xml.replace(new RegExp(`<TTGlyph name="${g}"[\\s\\S]*?</TTGlyph>`, 'u'), (glyph) =>
      shiftGlyph(glyph, dx),
    )
  })
  await writeFile(ttx, xml)
  fonttools('ttx', '-q', '-m', ttf, '-o', ttf, ttx)
  console.log(`  digits → ${target} units`)
}

/** Garamond roman or italic: weight clamped to 400–700, the text features kept. */
async function buildGaramond(src: Source, name: string): Promise<void> {
  const clamped = join(CACHE, `${name}-400-700.ttf`)
  fonttools('varLib.instancer', await fetchSource(src), 'wght=400:700', '-q', '-o', clamped)
  await subset(clamped, join(OUT, `${name}.woff2`), TEXT_FEATURES)
}

/** A static Oswald instance with tabular digits. */
async function buildOswald(weight: number): Promise<void> {
  const inst = join(CACHE, `oswald-${weight}.ttf`)
  const src = await fetchSource(SRC.oswald)
  fonttools('varLib.instancer', src, `wght=${weight}`, '-q', '--update-name-table', '-o', inst)
  await tabularDigits(inst)
  await subset(inst, join(OUT, `oswald-${weight}.woff2`))
}

await mkdir(CACHE, { recursive: true })
await mkdir(OUT, { recursive: true })
await buildGaramond(SRC.garamond, 'eb-garamond')
await buildGaramond(SRC.garamondItalic, 'eb-garamond-italic')
await buildOswald(500)
await buildOswald(600)
await subset(await fetchSource(SRC.ultra), join(OUT, 'ultra.woff2'))
await subset(await fetchSource(SRC.rye), join(OUT, 'rye.woff2'))
