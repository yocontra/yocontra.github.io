// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * Casting audit: Gemini listens to each shipped voice file (`public/.../voice/<id>.m4a`) blind and
 * reports the perceived gender, age, accent and timbre of the speaker, with a transcript and any
 * problems; the roster says who he is meant to be (a `woman` rig is a woman, everyone else a man).
 *
 *   bun tools/audio/cast-audit.ts [<cast id>…] [--out <file.json>]
 *
 * Runs on Vertex (Gemini 2.5 Pro listening); nothing is spent on ElevenLabs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VOICE_CAST } from '../../src/experiments/out-west/audio/voices.ts'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { load, SR } from './dsp.ts'
import { listen } from './vendors.ts'
import { CAST, type Cast, PLAYER } from './voices.ts'

const PUB = resolve(import.meta.dir, '../../public/experiments/out-west/3d/voice')

export interface Heard {
  gender: 'male' | 'female' | 'ambiguous'
  genderConfidence: number
  age: string
  accent: string
  timbre: string
  transcript: string
  problems: string
}

/** Who each character is meant to be: the roster's base body (a `woman` rig is a woman). */
export function intended(c: Cast): 'male' | 'female' {
  if (c.id === PLAYER.id) {
    return 'male'
  }
  return OUTLAWS.find((x) => x.name === c.name)?.look.base === 'woman' ? 'female' : 'male'
}

const BLIND =
  'You are a casting director. Listen to this voice recording (several short lines from one game character, with gaps). Judge the voice ONLY from its sound, not from the words. Reply with JSON only: {"gender": "male"|"female"|"ambiguous" (the perceived sex of the voice), "genderConfidence": 0-1, "age": string (estimated age range, e.g. "30-40"), "accent": string, "timbre": string (pitch, texture, energy in a few words), "transcript": string (every spoken line, separated by " | "; non-verbal sounds in brackets), "problems": string (robotic or synthetic sound, clipped words, mispronunciations, wrong pacing, artifacts; "none" if clean)}'

export async function hear(file: string): Promise<Heard> {
  const ask = () => listen(file, BLIND)
  const r = await ask().catch(ask)
  return JSON.parse(r) as Heard
}

/**
 * Median fundamental of the voiced frames, Hz (YIN, 40 ms frames): adult men speak around
 * 85–155 Hz, women 165–255 Hz. A whisper or a grunt has little pitch, so few frames count.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: YIN is one tight loop nest; split, it reads worse
export function medianF0(x: Float32Array): { f0: number; voiced: number } {
  const n = Math.round(SR * 0.04)
  const maxLag = Math.round(SR / 60)
  const minLag = Math.round(SR / 400)
  let pk = 0
  for (const v of x) {
    pk = Math.max(pk, Math.abs(v))
  }
  const f0s: number[] = []
  let frames = 0
  const d = new Float32Array(maxLag + 1)
  for (let s = 0; s + n + maxLag < x.length; s += n / 2) {
    let e = 0
    for (let i = 0; i < n; i++) {
      e += (x[s + i] ?? 0) ** 2
    }
    if (Math.sqrt(e / n) < pk * 0.05) {
      continue
    }
    frames++
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = 0; i < n; i += 2) {
        const v = (x[s + i] ?? 0) - (x[s + i + lag] ?? 0)
        sum += v * v
      }
      d[lag] = sum
    }
    // cumulative mean normalised difference, first dip under the threshold
    let run = 0
    let best = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      run += d[lag] ?? 0
      const c = ((d[lag] ?? 0) * (lag - minLag + 1)) / (run || 1)
      if (c < 0.2) {
        while (lag + 1 <= maxLag && (d[lag + 1] ?? 0) < (d[lag] ?? 0)) {
          lag++
        }
        best = lag
        break
      }
    }
    if (best > 0) {
      f0s.push(SR / best)
    }
  }
  f0s.sort((a, b) => a - b)
  return {
    f0: Math.round(f0s[Math.floor(f0s.length / 2)] ?? 0),
    voiced: frames > 0 ? f0s.length / frames : 0,
  }
}

/** The captioned lines of a speaker's shipped file, end to end (grunts and deaths left out). */
function spoken(c: Cast): Float32Array {
  const x = load(`${PUB}/${c.id}.m4a`, 1, 'highpass=f=60,lowpass=f=1200')[0] ?? new Float32Array(0)
  const parts = (VOICE_CAST[c.name]?.lines ?? [])
    .filter((l) => l.text !== '' && l.text !== '…' && l.text !== '*hic*')
    .map((l) => x.subarray(Math.round(l.at * SR), Math.round((l.at + l.len) * SR)))
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const LINE =
  'You are a strict dialogue editor for a western video game. Listen to this single voice line. Reply with JSON only: {"transcript": string (exactly the words spoken, with any stammer, hiccup or non-verbal sound in brackets), "matches": boolean (true only if the spoken words match the caption exactly; a stammer, an apostrophe dropped g or a pause written as an ellipsis is fine when it is performed), "delivery": string (a few words), "problems": string (robotic, flat, clipped, mispronounced, wrong stress, artifacts; "none" if clean), "quality": 1-10 (as a AAA game performance)}'

export interface LineCheck {
  transcript: string
  matches: boolean
  delivery: string
  problems: string
  quality: number
}

/** Gemini checks every captioned line of the shipped files against its caption. */
async function checkLines(ids: string[], tmp: string): Promise<void> {
  mkdirSync(tmp, { recursive: true })
  const jobs: { c: Cast; text: string; at: number; len: number; i: number }[] = []
  for (const c of CAST.filter((x) => ids.length === 0 || ids.includes(x.id))) {
    for (const [i, l] of (VOICE_CAST[c.name]?.lines ?? []).entries()) {
      if (l.text !== '') {
        jobs.push({ c, text: l.text, at: l.at, len: l.len, i })
      }
    }
  }
  const worker = async (): Promise<void> => {
    for (let j = jobs.shift(); j !== undefined; j = jobs.shift()) {
      const wav = `${tmp}/${j.c.id}-${j.i}.wav`
      Bun.spawnSync([
        '/opt/homebrew/bin/ffmpeg',
        '-v',
        'error',
        '-y',
        '-ss',
        String(j.at),
        '-t',
        String(j.len),
        '-i',
        `${PUB}/${j.c.id}.m4a`,
        wav,
      ])
      const ask = () => listen(wav, `Caption: "${j.text}". ${LINE}`)
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each worker listens one line at a time (rate limits)
        const r = JSON.parse(await ask().catch(ask)) as LineCheck
        console.log(
          `${r.matches ? 'ok      ' : 'MISMATCH'} q${r.quality} ${j.c.id}/${j.i} "${j.text}" heard "${r.transcript}" | ${r.delivery} | ${r.problems}`,
        )
      } catch (e) {
        console.log(`FAIL ${j.c.id}/${j.i}: ${String(e).slice(0, 200)}`)
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--lines')) {
    await checkLines(
      argv.filter((a) => !a.startsWith('--')),
      resolve(import.meta.dir, 'raw/lines'),
    )
    return
  }
  if (argv.includes('--pitch')) {
    for (const c of CAST) {
      const p = medianF0(spoken(c))
      console.log(
        `${c.id.padEnd(13)} ${intended(c).padEnd(6)} F0 ${p.f0} Hz (voiced ${(p.voiced * 100).toFixed(0)}%)`,
      )
    }
    return
  }
  const oi = argv.indexOf('--out')
  const out = oi >= 0 ? argv[oi + 1] : undefined
  const ids = argv.filter((a, i) => !(a.startsWith('--') || argv[i - 1] === '--out'))
  const jobs = [...CAST, PLAYER].filter((c) => ids.length === 0 || ids.includes(c.id))
  const rows: Record<string, Heard & { intended: string }> = {}
  const worker = async (): Promise<void> => {
    for (let c = jobs.shift(); c !== undefined; c = jobs.shift()) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each worker listens one file at a time (rate limits)
        const h = await hear(`${PUB}/${c.id}.m4a`)
        const want = intended(c)
        rows[c.id] = { ...h, intended: want }
        console.log(
          `${h.gender === want ? 'ok      ' : 'MISMATCH'} ${c.id.padEnd(13)} want ${want.padEnd(6)} heard ${h.gender} (${h.genderConfidence}) ${h.age} | ${h.accent} | ${h.timbre} | ${h.problems}`,
        )
      } catch (e) {
        console.log(`FAIL ${c.id}: ${String(e).slice(0, 200)}`)
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (out) {
    writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`)
  }
}

if (import.meta.main) {
  await main()
}
