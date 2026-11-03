// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
// biome-ignore-all lint/performance/useTopLevelRegex: ffmpeg log parsing, run once per file
// biome-ignore-all lint/style/useNamedCaptureGroup: one-number captures from ffmpeg logs
// biome-ignore-all lint/complexity/useMaxParams: DSP helpers take positional numeric args (frequencies, times, levels), like ffmpeg filters
/**
 * Small offline DSP kit for the out west audio build: ffmpeg does decoding, filtering, loudness
 * measurement and AAC encoding; TypeScript does the sample-exact work (trims, layering, fades,
 * onset slicing, loop crossfades).
 *
 * Audio is `Ch`: one Float32Array per channel at 48 kHz (the rate the game's AudioContext runs at,
 * so the browser never resamples on decode).
 */

export const SR = 48_000
const FFMPEG = '/opt/homebrew/bin/ffmpeg'

export type Ch = Float32Array[]

const dbToLin = (d: number) => 10 ** (d / 20)
export const linToDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -200)

function interleave(ch: Ch): Buffer {
  const n = ch[0]?.length ?? 0
  const out = new Float32Array(n * ch.length)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch.length; c++) {
      out[i * ch.length + c] = ch[c]?.[i] ?? 0
    }
  }
  return Buffer.from(out.buffer)
}

function deinterleave(buf: Buffer, channels: number): Ch {
  const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
  const n = Math.floor(all.length / channels)
  const out: Ch = Array.from({ length: channels }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const dst = out[c]
      if (dst) {
        dst[i] = all[i * channels + c] ?? 0
      }
    }
  }
  return out
}

function ff(args: string[], stdin?: Buffer): { out: Buffer; err: string } {
  const p = Bun.spawnSync([FFMPEG, '-hide_banner', '-nostats', '-v', 'info', ...args], {
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`ffmpeg ${args.join(' ')}\n${p.stderr.toString().slice(-1500)}`)
  }
  return { out: p.stdout, err: p.stderr.toString() }
}

const rawIn = (channels: number) => ['-f', 'f32le', '-ar', String(SR), '-ac', String(channels)]

/** Decode any file to `channels` channels at 48 kHz, optionally through an ffmpeg filter. */
export function load(path: string, channels: 1 | 2, filter?: string): Ch {
  const af = filter ? ['-af', filter] : []
  const { out } = ff([
    '-i',
    path,
    ...af,
    '-ac',
    String(channels),
    '-ar',
    String(SR),
    '-f',
    'f32le',
    '-',
  ])
  return deinterleave(out, channels)
}

/** Run audio through an ffmpeg filter chain (sample-exact length is not guaranteed by every filter). */
export function filt(ch: Ch, filter: string, outChannels = ch.length): Ch {
  const { out } = ff(
    [
      ...rawIn(ch.length),
      '-i',
      'pipe:0',
      '-af',
      filter,
      '-ac',
      String(outChannels),
      '-f',
      'f32le',
      '-',
    ],
    interleave(ch),
  )
  return deinterleave(out, outChannels)
}

export const len = (ch: Ch) => ch[0]?.length ?? 0
export const secs = (ch: Ch) => len(ch) / SR

export function silence(seconds: number, channels: number): Ch {
  return Array.from({ length: channels }, () => new Float32Array(Math.round(seconds * SR)))
}

export function slice(ch: Ch, from: number, to = secs(ch)): Ch {
  const a = Math.max(0, Math.round(from * SR))
  const b = Math.min(len(ch), Math.round(to * SR))
  return ch.map((c) => c.slice(a, b))
}

export function mono(ch: Ch): Ch {
  const out = new Float32Array(len(ch))
  for (const c of ch) {
    for (let i = 0; i < out.length; i++) {
      out[i] = (out[i] ?? 0) + (c[i] ?? 0) / ch.length
    }
  }
  return [out]
}

export function toChannels(ch: Ch, n: number): Ch {
  if (ch.length === n) {
    return ch
  }
  const m = mono(ch)[0] ?? new Float32Array(0)
  return Array.from({ length: n }, () => m.slice())
}

export function gain(ch: Ch, db: number): Ch {
  const k = dbToLin(db)
  return ch.map((c) => c.map((v) => v * k))
}

/** Add `src` into `dst` at `atSec` with `db` gain (dst grows if needed). */
export function mixInto(dst: Ch, src: Ch, atSec: number, db = 0): Ch {
  const at = Math.round(atSec * SR)
  const need = Math.max(len(dst), at + len(src))
  const k = dbToLin(db)
  const s = toChannels(src, dst.length)
  return dst.map((d, c) => {
    const out = new Float32Array(need)
    out.set(d)
    const sc = s[c] ?? new Float32Array(0)
    for (let i = 0; i < sc.length; i++) {
      const j = at + i
      out[j] = (out[j] ?? 0) + (sc[i] ?? 0) * k
    }
    return out
  })
}

/** Equal-power-ish (sine) fades at both ends. */
export function fade(ch: Ch, inSec: number, outSec: number): Ch {
  const n = len(ch)
  const fi = Math.min(n, Math.round(inSec * SR))
  const fo = Math.min(n, Math.round(outSec * SR))
  return ch.map((c) => {
    const o = c.slice()
    for (let i = 0; i < fi; i++) {
      o[i] = (o[i] ?? 0) * Math.sin((i / fi) * (Math.PI / 2))
    }
    for (let i = 0; i < fo; i++) {
      const j = n - fo + i
      o[j] = (o[j] ?? 0) * Math.cos(((i + 1) / fo) * (Math.PI / 2))
    }
    return o
  })
}

export function concat(...parts: Ch[]): Ch {
  const channels = Math.max(...parts.map((p) => p.length))
  const fixed = parts.map((p) => toChannels(p, channels))
  const total = fixed.reduce((a, p) => a + len(p), 0)
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(total)
    let at = 0
    for (const p of fixed) {
      const pc = p[c] ?? new Float32Array(0)
      out.set(pc, at)
      at += pc.length
    }
    return out
  })
}

export function peak(ch: Ch): number {
  let p = 0
  for (const c of ch) {
    for (const v of c) {
      p = Math.max(p, Math.abs(v))
    }
  }
  return p
}

/** First time the signal crosses `relDb` below its own peak. */
export function onset(ch: Ch, relDb = -20): number {
  const th = peak(ch) * dbToLin(relDb)
  const m = mono(ch)[0] ?? new Float32Array(0)
  const i = m.findIndex((v) => Math.abs(v) >= th)
  return Math.max(0, i) / SR
}

/**
 * Up to `n` separate events (footsteps, jingles): peaks of a 10 ms envelope above `relDb` of the
 * loudest, at least `gap` seconds apart, returned in time order (seconds, at each event's attack).
 */
export function events(ch: Ch, n: number, gap: number, relDb = -24): number[] {
  const m = mono(ch)[0] ?? new Float32Array(0)
  const hop = Math.round(0.01 * SR)
  const env: number[] = []
  for (let i = 0; i < m.length; i += hop) {
    let p = 0
    for (let j = i; j < Math.min(m.length, i + hop); j++) {
      p = Math.max(p, Math.abs(m[j] ?? 0))
    }
    env.push(p)
  }
  const top = Math.max(...env)
  const cands = env
    .map((v, i) => ({ v, i }))
    .filter((e) => e.v >= top * dbToLin(relDb))
    .sort((a, b) => b.v - a.v)
  const picked: number[] = []
  for (const c of cands) {
    if (picked.every((p) => Math.abs(p - c.i) * 0.01 >= gap)) {
      picked.push(c.i)
    }
    if (picked.length >= n) {
      break
    }
  }
  // Walk back from each peak to where the attack starts (first frame within 18 dB of it).
  return picked
    .sort((a, b) => a - b)
    .map((i) => {
      let k = i
      const floor = (env[i] ?? 0) * dbToLin(-18)
      while (k > 0 && (env[k - 1] ?? 0) > floor && i - k < 8) {
        k--
      }
      return k * 0.01
    })
}

/**
 * Make [start, end) loop seamlessly by crossfading its last `x` seconds with the audio that leads
 * into `start` (or, when there is none, its first `x` seconds with the audio after `end - x`).
 * Returns the loop body; playing it end-to-start is sample-continuous.
 */
export function loopify(ch: Ch, start: number, end: number, x: number): Ch {
  const s = Math.round(start * SR)
  const e = Math.round(end * SR)
  const w = Math.round(x * SR)
  if (s >= w) {
    return ch.map((c) => {
      const body = c.slice(s, e)
      for (let i = 0; i < w; i++) {
        const t = i / w
        const j = body.length - w + i
        body[j] =
          (c[e - w + i] ?? 0) * Math.cos((t * Math.PI) / 2) +
          (c[s - w + i] ?? 0) * Math.sin((t * Math.PI) / 2)
      }
      return body
    })
  }
  return ch.map((c) => {
    const body = c.slice(s, e - w)
    for (let i = 0; i < w; i++) {
      const t = i / w
      body[i] =
        (c[s + i] ?? 0) * Math.sin((t * Math.PI) / 2) +
        (c[e - w + i] ?? 0) * Math.cos((t * Math.PI) / 2)
    }
    return body
  })
}

/** A streamed loop file: `pre` seconds of lead-in, the body, then `post` seconds wrapping to its start. */
export interface Packed {
  ch: Ch
  loopStart: number
  loopEnd: number
}

/** Lay out a loop for the dual-deck streamer: [lead-in | body | first `post` s of body again]. */
export function pack(body: Ch, leadIn: Ch, post: number): Packed {
  const tail = slice(body, 0, post)
  const ch = concat(leadIn, body, tail)
  return { ch, loopStart: secs(leadIn), loopEnd: secs(leadIn) + secs(body) }
}

/** Synth: a pitch-dropping sine thump (gunshot chest punch, heartbeat sub). */
export function thump(f0: number, f1: number, decay: number, seconds: number): Ch {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.03)
    ph += (2 * Math.PI * f) / SR
    const a = Math.min(1, t / 0.0015) * Math.exp(-t / decay)
    out[i] = Math.sin(ph) * a
  }
  return [out]
}

/** Synth: a dry wooden UI tick (two damped resonances and a noise click). */
export function tick(): Ch {
  const n = Math.round(0.09 * SR)
  const out = new Float32Array(n)
  let seed = 7
  const rnd = () => {
    seed = (seed * 16_807) % 2_147_483_647
    return seed / 2_147_483_647 - 0.5
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const body = Math.sin(2 * Math.PI * 1850 * t) * Math.exp(-t / 0.006) * 0.7
    const knock = Math.sin(2 * Math.PI * 620 * t) * Math.exp(-t / 0.011) * 0.5
    const click = rnd() * Math.exp(-t / 0.0007) * 1.2
    out[i] = (body + knock + click) * Math.min(1, t / 0.0004)
  }
  return [out]
}

export interface Loudness {
  /** Integrated LUFS, or the loudest 400 ms momentary reading when too short to gate. */
  lufs: number
  /** True peak, dBTP. */
  tp: number
}

function parseEbu(err: string): Loudness {
  const sum = err.slice(err.lastIndexOf('Summary:'))
  let lufs = Number.parseFloat(sum.match(/I:\s*(-?[\d.]+) LUFS/u)?.[1] ?? 'NaN')
  if (!Number.isFinite(lufs) || lufs <= -69) {
    const ms = [...err.matchAll(/ M:\s*(-?[\d.]+)/gu)].map((m) => Number.parseFloat(m[1] ?? ''))
    lufs = Math.max(...ms.filter(Number.isFinite))
  }
  const tp = Number.parseFloat(sum.match(/True peak:\s*Peak:\s*(-?[\d.]+|-inf)/u)?.[1] ?? '-200')
  return { lufs, tp: Number.isFinite(tp) ? tp : -200 }
}

export function loudness(ch: Ch): Loudness {
  const { err } = ff(
    [
      ...rawIn(ch.length),
      '-i',
      'pipe:0',
      '-af',
      'apad=whole_dur=0.5,ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    interleave(ch),
  )
  return parseEbu(err)
}

export function loudnessOf(path: string): Loudness {
  const { err } = ff(['-i', path, '-af', 'apad=whole_dur=0.5,ebur128=peak=true', '-f', 'null', '-'])
  return parseEbu(err)
}

/** Lookahead peak limiter (delay-compensated, so slices stay on their grid). */
export function limit(ch: Ch, ceilingDb: number): Ch {
  const out = filt(
    ch,
    `alimiter=limit=${dbToLin(ceilingDb).toFixed(5)}:attack=1:release=60:level=disabled:latency=1`,
  )
  // Keep the exact length (the limiter may pad or trim a few samples).
  return out.map((c) => {
    const o = new Float32Array(len(ch))
    o.set(c.subarray(0, o.length))
    return o
  })
}

export interface Encoded {
  lufs: number
  tp: number
  gainDb: number
  limitDb: number
  bytes: number
}

/**
 * Bring `ch` to `target` LUFS with true peak ≤ −1 dBTP after AAC encoding. Peaks above the ceiling
 * are limited, by at most `maxGR` dB; past that the whole sound is turned down instead (it then
 * lands under target, and the report shows it). Writes AAC-LC `.m4a` (Apple encoder, faststart).
 */
export function master(ch: Ch, out: string, target: number, maxGR: number, kbps: number): Encoded {
  const m = loudness(ch)
  let g = target - m.lufs
  const peakDb = linToDb(peak(ch))
  // How much the limiter would have to take off the peaks at this gain.
  const over = peakDb + g - -2
  if (over > maxGR) {
    g -= over - maxGR
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const ceiling = -2 - attempt * 0.5
    let x = gain(ch, g)
    const limitDb = Math.max(0, linToDb(peak(x)) - ceiling)
    if (limitDb > 0) {
      x = limit(x, ceiling)
    }
    encode(x, out, kbps)
    const r = loudnessOf(out)
    if (r.tp <= -1) {
      return { lufs: r.lufs, tp: r.tp, gainDb: g, limitDb, bytes: Bun.file(out).size }
    }
  }
  throw new Error(`${out}: could not hold true peak under -1 dBTP`)
}

export function encode(ch: Ch, out: string, kbps: number): void {
  ff(
    [
      '-y',
      ...rawIn(ch.length),
      '-i',
      'pipe:0',
      '-c:a',
      'aac_at',
      '-b:a',
      `${kbps}k`,
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      out,
    ],
    interleave(ch),
  )
}
