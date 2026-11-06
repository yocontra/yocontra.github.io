// biome-ignore-all lint/performance/useTopLevelRegex: ffmpeg log parsing, run once per file
// biome-ignore-all lint/style/useNamedCaptureGroup: one-number captures from ffmpeg logs
/**
 * Offline loudness report for every audio file under the given directories (or files).
 *
 *   bun tools/audio/loudness.ts public/experiments/out-west/3d/sfx public/experiments/out-west/3d/music
 *
 * Per file: codec, channels, sample rate, bitrate, duration, size, integrated loudness (LUFS),
 * loudness range (LU), true peak (dBTP), sample peak, and the level of the first and last 10 ms
 * (a hot head or tail means a click or a truncated tail). Prints a Markdown table, then flags
 * anything outside the targets: SFX −16 ±2 LUFS, music −18 ±2 LUFS, true peak ≤ −1 dBTP.
 * One-shots too short for the gated integral fall back to their loudest 400 ms momentary reading.
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const FFPROBE = '/opt/homebrew/bin/ffprobe'
const AUDIO = /\.(m4a|mp3|wav|ogg|aac)$/iu

export interface Row {
  file: string
  codec: string
  ch: number
  rate: number
  kbps: number
  dur: number
  kb: number
  lufs: number
  lra: number
  tp: number
  peak: number
  head: number
  tail: number
}

function run(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  return `${p.stdout.toString()}\n${p.stderr.toString()}`
}

function num(re: RegExp, s: string, fallback = Number.NaN): number {
  const m = s.match(re)
  return m?.[1] ? Number.parseFloat(m[1]) : fallback
}

/** Peak level (dBFS) of a window of the file. */
function windowPeak(file: string, from: number, len: number): number {
  const out = run([
    FFMPEG,
    '-hide_banner',
    '-nostats',
    '-ss',
    String(Math.max(0, from)),
    '-t',
    String(len),
    '-i',
    file,
    '-af',
    'astats=metadata=0:measure_perchannel=none',
    '-f',
    'null',
    '-',
  ])
  return num(/Peak level dB:\s*(-?[\d.]+|-inf)/u, out, -120)
}

export function measure(file: string): Row {
  const probe = run([
    FFPROBE,
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,channels,sample_rate,bit_rate:format=duration',
    '-of',
    'default=nw=1',
    file,
  ])
  const dur = num(/duration=([\d.]+)/u, probe, 0)
  const ebu = run([
    FFMPEG,
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-af',
    // Pad one-shots shorter than the 400 ms momentary window so they still get a reading.
    // biome-ignore lint/security/noSecrets: an ffmpeg filter graph, not a secret
    'apad=whole_dur=0.5,ebur128=peak=true+sample',
    '-f',
    'null',
    '-',
  ])
  const summary = ebu.slice(ebu.lastIndexOf('Summary:'))
  let lufs = num(/I:\s*(-?[\d.]+) LUFS/u, summary)
  if (!Number.isFinite(lufs) || lufs < -69) {
    // Too short for the gated integral: use the loudest momentary (400 ms) reading instead.
    const moments = [...ebu.matchAll(/ M:\s*(-?[\d.]+)/gu)].map((m) =>
      Number.parseFloat(m[1] ?? ''),
    )
    lufs = Math.max(...moments.filter(Number.isFinite))
  }
  return {
    file: basename(file),
    codec: probe.match(/codec_name=(\w+)/u)?.[1] ?? '?',
    ch: num(/channels=(\d+)/u, probe, 0),
    rate: num(/sample_rate=(\d+)/u, probe, 0),
    kbps: Math.round(num(/bit_rate=(\d+)/u, probe, 0) / 1000),
    dur,
    kb: Math.round(statSync(file).size / 1024),
    lufs,
    lra: num(/LRA:\s*(-?[\d.]+) LU/u, summary),
    tp: num(/True peak:\s*Peak:\s*(-?[\d.]+|-inf) dBFS/u, summary),
    peak: num(/Sample peak:\s*Peak:\s*(-?[\d.]+|-inf) dBFS/u, summary),
    head: windowPeak(file, 0, 0.01),
    tail: windowPeak(file, Math.max(0, dur - 0.03), 0.025),
  }
}

function files(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (AUDIO.test(f)) {
          out.push(join(p, f))
        }
      }
    } else if (AUDIO.test(p)) {
      out.push(p)
    }
  }
  return out
}

const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : String(n))

function main(): void {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const list = files(args.filter((a) => !a.startsWith('--')))
  const rows = list.map(measure)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  console.log(
    '| file | codec | ch | Hz | kbps | dur s | KB | LUFS | LRA | dBTP | head dB | tail dB |',
  )
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(
      `| ${r.file} | ${r.codec} | ${r.ch} | ${r.rate} | ${r.kbps} | ${r.dur.toFixed(2)} | ${r.kb} | ${f1(r.lufs)} | ${f1(r.lra)} | ${f1(r.tp)} | ${f1(r.head)} | ${f1(r.tail)} |`,
    )
  }
  const total = rows.reduce((a, r) => a + r.kb, 0)
  console.log(`\n${rows.length} files, ${(total / 1024).toFixed(2)} MB`)
  for (const r of rows) {
    if (r.tp > -0.95) {
      console.log(`! ${r.file}: true peak ${f1(r.tp)} dBTP > -1`)
    }
    if (r.tail > -40 && r.dur > 0.3) {
      console.log(`! ${r.file}: tail ${f1(r.tail)} dB (cut off or a loop)`)
    }
  }
}

if (import.meta.main) {
  main()
}
