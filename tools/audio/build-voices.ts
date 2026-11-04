// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * Master the voice takes (`speak.ts`, picks in `voice-picks.ts`) into one small file per speaker.
 *
 *   bun tools/audio/build-voices.ts [<cast id>…]
 *
 * Each line is cleaned (rumble cut, pitched when the cast shares a voice, trimmed to its sound,
 * evened out by a gentle compressor), brought to its kind's loudness, and laid end to end with a
 * short gap; the whole file is then mastered (true peak ≤ −1 dBTP) and encoded as mono AAC. The
 * offsets go to `src/experiments/out-west/audio/voices.ts`, which the engine plays slices from.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type Ch,
  concat,
  fade,
  gain,
  linToDb,
  load,
  loudness,
  master,
  SR,
  secs,
  silence,
  slice,
} from './dsp.ts'
import { takePath } from './speak.ts'
import { VOICE_PICKS } from './voice-picks.ts'
import { CAST, type Cast, effortLines, type Line, linesOf, PLAYER } from './voices.ts'

const ROOT = resolve(import.meta.dir, '../..')
const PUB = resolve(ROOT, 'public/experiments/out-west/3d/voice')
const OUT_TS = resolve(ROOT, 'src/experiments/out-west/audio/voices.ts')
const KBPS = 40
/** Silence between lines in a file, s (the engine plays exact slices; this only keeps tails apart). */
const GAP = 0.12

/** Loudness each kind of line is brought to before the file is mastered, LUFS (momentary). */
const TARGET: Readonly<Record<Line['kind'], number>> = {
  open: -16,
  taunt: -16,
  death: -17,
  draw: -20,
  flinch: -21,
  win: -22,
}

interface Placed {
  key: string
  kind: Line['kind']
  text: string
  at: number
  len: number
}

/** First and last sample above `rel` dB under the peak. */
function bounds(x: Float32Array, rel: number): [number, number] {
  let pk = 0
  for (const v of x) {
    pk = Math.max(pk, Math.abs(v))
  }
  const th = pk * 10 ** (rel / 20)
  let a = 0
  while (a < x.length && Math.abs(x[a] ?? 0) < th) {
    a++
  }
  let b = x.length - 1
  while (b > a && Math.abs(x[b] ?? 0) < th) {
    b--
  }
  return [a, b]
}

function clean(c: Cast, l: Line): Ch | null {
  const take = VOICE_PICKS[`${c.id}/${l.key}`] ?? 1
  const f = takePath(c, l.key, take)
  if (!existsSync(f)) {
    console.log(`missing ${c.id}/${l.key} (take ${take})`)
    return null
  }
  const r = 2 ** ((c.semis ?? 0) / 12)
  const shift = c.semis
    ? `,asetrate=${Math.round(SR * r)},aresample=${SR},atempo=${(1 / r).toFixed(6)}`
    : ''
  // rumble and mic thump off, a touch of presence, then an even, gentle squeeze
  const x = load(
    f,
    1,
    `highpass=f=90${shift},equalizer=f=3200:t=q:w=1.2:g=2,acompressor=threshold=-24dB:ratio=3:attack=5:release=120:makeup=1`,
  )
  const ch = x[0] ?? new Float32Array(0)
  const [a, b] = bounds(ch, -38)
  const cut = slice(x, Math.max(0, a / SR - 0.03), Math.min(secs(x), b / SR + 0.08))
  const m = loudness(cut)
  return fade(gain(cut, TARGET[l.kind] - m.lufs), 0.008, 0.05)
}

function build(c: Cast): {
  url: string
  placed: Placed[]
  bytes: number
  lufs: number
  tp: number
} {
  const lines = c.id === PLAYER.id ? effortLines() : linesOf(c)
  const parts: Ch[] = []
  const placed: Placed[] = []
  let t = 0
  for (const l of lines) {
    const x = clean(c, l)
    if (x) {
      parts.push(x, silence(GAP, 1))
      placed.push({ key: l.key, kind: l.kind, text: l.text, at: t, len: secs(x) })
      t += secs(x) + GAP
    }
  }
  const all = concat(...parts)
  const out = `${PUB}/${c.id}.m4a`
  const e = master(all, out, -16, 6, KBPS)
  console.log(
    `${c.id.padEnd(13)} ${String(placed.length).padStart(2)} lines ${secs(all).toFixed(1).padStart(5)}s ${(e.bytes / 1024).toFixed(0).padStart(4)}KB  ${e.lufs.toFixed(1)} LUFS  ${e.tp.toFixed(1)} dBTP  gain ${e.gainDb.toFixed(1)}  peak ${linToDb(Math.max(...all.map((ch) => ch.reduce((p, v) => Math.max(p, Math.abs(v)), 0)))).toFixed(1)}`,
  )
  return {
    url: `/experiments/out-west/3d/voice/${c.id}.m4a`,
    placed,
    bytes: e.bytes,
    lufs: e.lufs,
    tp: e.tp,
  }
}

const q = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
const n = (v: number) => Number(v.toFixed(3))

function main(): void {
  const only = process.argv.slice(2)
  mkdirSync(PUB, { recursive: true })
  const casts = [...CAST, PLAYER].filter((c) => only.length === 0 || only.includes(c.id))
  const built = new Map<string, ReturnType<typeof build>>()
  for (const c of casts) {
    built.set(c.id, build(c))
  }
  if (only.length > 0 && existsSync(OUT_TS)) {
    console.log('(partial build: voices.ts is regenerated only by a full build)')
    return
  }
  const line = (pl: Placed) =>
    `      { kind: '${pl.kind}', text: ${q(pl.text)}, at: ${n(pl.at)}, len: ${n(pl.len)} },`
  const cast = CAST.map((c) => {
    const b = built.get(c.id)
    return b
      ? `  ${q(c.name)}: {\n    url: '${b.url}',\n    lines: [\n${b.placed.map(line).join('\n')}\n    ],\n  },`
      : ''
  }).join('\n')
  const p = built.get(PLAYER.id)
  const effort = (k: string) =>
    (p?.placed ?? [])
      .filter((x) => x.kind === k)
      .map((x) => `{ kind: '${k}', text: '', at: ${n(x.at)}, len: ${n(x.len)} }`)
      .join(', ')
  const total = [...built.values()].reduce((a, b) => a + b.bytes, 0)
  writeFileSync(
    OUT_TS,
    `// biome-ignore-all lint/style/useNamingConvention: keys are the roster's names, as the captions name the speaker
// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: slice times, not constants
/**
 * Voice lines, written by \`tools/audio/build-voices.ts\`. Do not edit by hand.
 *
 * One mono file per speaker (${(total / 1024).toFixed(0)} KB in all), fetched only when his duel is
 * staged (\`AudioEngine.loadVoice\`). Each line is a slice of it: \`at\` and \`len\` in seconds.
 * \`text\` is the caption it voices ('' for a grunt or a breath).
 */
export type VoiceKind = 'open' | 'taunt' | 'death'
export type EffortKind = 'draw' | 'flinch' | 'win' | 'death'

export interface VoiceLine {
  readonly kind: VoiceKind | EffortKind
  readonly text: string
  readonly at: number
  readonly len: number
}

export interface VoiceFile {
  readonly url: string
  readonly lines: readonly VoiceLine[]
}

/** Outlaws by roster name. */
export const VOICE_CAST: Readonly<Record<string, VoiceFile>> = {
${cast}
}

/** The player's breaths and grunts. */
export const PLAYER_VOICE: {
  readonly url: string
  readonly efforts: Readonly<Record<EffortKind, readonly VoiceLine[]>>
} = {
  url: '${p?.url ?? ''}',
  efforts: {
    draw: [${effort('draw')}],
    flinch: [${effort('flinch')}],
    win: [${effort('win')}],
    death: [${effort('death')}],
  },
}
`,
  )
  console.log(`voices: ${(total / 1024).toFixed(0)} KB in ${built.size} files`)
}

if (import.meta.main) {
  main()
}
