// biome-ignore-all lint/complexity/useMaxParams: synth helpers take positional numeric args (times, corners, levels), like the DSP kit
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the tracker is one linear pipeline (envelope, tempo, phase, fit, downbeat)
/**
 * A small beat tracker and percussion kit for the streak layer (`recipes.ts`): finds a generated
 * theme's tempo and beat grid from its onset strength, so its loop can be cut on whole bars and a
 * galloping percussion layer laid exactly on its beats.
 *
 * Every drum is synthesised here (toms, a dry rim knock, a shaker): no bell, chime or metal
 * resonance, so nothing in the layer can be mistaken for the call.
 */

import { type Ch, mono, SR } from './dsp.ts'
import { fft } from './loops.ts'

/** Onset-envelope hop, s. */
const HOP = 0.01
const N = 1024

/** Half-wave-rectified log-spectral flux every HOP seconds, over `lo`–`hi` Hz. */
function flux(x: Float32Array, lo: number, hi: number): Float32Array {
  const hop = Math.round(HOP * SR)
  const frames = Math.max(0, Math.floor((x.length - N) / hop))
  const out = new Float32Array(frames)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const k0 = Math.max(1, Math.floor((lo * N) / SR))
  const k1 = Math.min(N / 2, Math.ceil((hi * N) / SR))
  let prev = new Float64Array(k1 - k0)
  for (let f = 0; f < frames; f++) {
    const at = f * hop
    for (let i = 0; i < N; i++) {
      re[i] = (x[at + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
      im[i] = 0
    }
    fft(re, im)
    const mag = new Float64Array(k1 - k0)
    let s = 0
    for (let k = k0; k < k1; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k] ?? 0, im[k] ?? 0))
      mag[k - k0] = m
      s += Math.max(0, m - (prev[k - k0] ?? 0))
    }
    out[f] = s
    prev = mag
  }
  // subtract a moving average so only the onsets stand out
  const w = 25
  const res = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let m = 0
    let c = 0
    for (let j = Math.max(0, f - w); j < Math.min(frames, f + w); j++) {
      m += out[j] ?? 0
      c++
    }
    res[f] = Math.max(0, (out[f] ?? 0) - m / c)
  }
  return res
}

export interface Grid {
  /** Beat period, s. */
  period: number
  bpm: number
  /** Every beat in the file, s. */
  beats: number[]
  /** Index into `beats` of the first downbeat (beat 1 of a 4/4 bar). */
  first: number
}

/** Tempo, beats and downbeats of a piece in 4/4 (`bpm` searched in 60–180, nearest 110 preferred). */
export function beatGrid(ch: Ch): Grid {
  const x = mono(ch)[0] ?? new Float32Array(0)
  const env = flux(x, 30, 8000)
  const bass = flux(x, 30, 200)
  const n = env.length
  // autocorrelation over the tempo range, gently weighted toward a moderate tempo
  let bestLag = 0
  let bestR = Number.NEGATIVE_INFINITY
  const ac = (lag: number) => {
    let r = 0
    for (let i = 0; i + lag < n; i++) {
      r += (env[i] ?? 0) * (env[i + lag] ?? 0)
    }
    return r / (n - lag)
  }
  for (let lag = Math.round(60 / 180 / HOP); lag <= Math.round(60 / 60 / HOP); lag++) {
    const bpm = 60 / (lag * HOP)
    const wgt = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2)
    const r = ac(lag) * wgt
    if (r > bestR) {
      bestR = r
      bestLag = lag
    }
  }
  // parabolic refinement of the lag
  const a = ac(bestLag - 1)
  const b = ac(bestLag)
  const c = ac(bestLag + 1)
  const den = a - 2 * b + c
  let period = (bestLag + (den === 0 ? 0 : (0.5 * (a - c)) / den)) * HOP
  // phase: the offset whose comb collects the most onset energy
  const combAt = (ph0: number, p: number) => {
    let s = 0
    for (let t = ph0; t < n * HOP; t += p) {
      s += env[Math.round(t / HOP)] ?? 0
    }
    return s
  }
  let phase = 0
  let best = Number.NEGATIVE_INFINITY
  for (let ph = 0; ph < period; ph += HOP) {
    const s = combAt(ph, period)
    if (s > best) {
      best = s
      phase = ph
    }
  }
  // refine period and phase by a least-squares fit to the local onset peaks near each beat
  const ts: number[] = []
  const ks: number[] = []
  for (let k = 0, t = phase; t < n * HOP; k++, t = phase + k * period) {
    let bi = Math.round(t / HOP)
    let bv = -1
    for (let j = bi - 4; j <= bi + 4; j++) {
      if ((env[j] ?? -1) > bv) {
        bv = env[j] ?? -1
        bi = j
      }
    }
    if (bv > 0) {
      ts.push(bi * HOP)
      ks.push(k)
    }
  }
  if (ts.length > 8) {
    const mk = ks.reduce((s, v) => s + v, 0) / ks.length
    const mt = ts.reduce((s, v) => s + v, 0) / ts.length
    let num = 0
    let dk = 0
    for (let i = 0; i < ts.length; i++) {
      num += ((ks[i] ?? 0) - mk) * ((ts[i] ?? 0) - mt)
      dk += ((ks[i] ?? 0) - mk) ** 2
    }
    period = num / dk
    phase = mt - period * mk
  }
  const beats: number[] = []
  for (let k = 0; phase + k * period < n * HOP + N / SR; k++) {
    if (phase + k * period >= 0) {
      beats.push(phase + k * period)
    }
  }
  // the downbeat: the beat of the bar where the low end hits hardest
  const sums = [0, 0, 0, 0]
  beats.forEach((t, i) => {
    sums[i % 4] = (sums[i % 4] ?? 0) + (bass[Math.round(t / HOP)] ?? 0)
  })
  const first = sums.indexOf(Math.max(...sums))
  return { period, bpm: 60 / period, beats, first }
}

// ------------------------------------------------------------------ the kit

let seed = 11
const rnd = () => {
  seed = (seed * 16_807) % 2_147_483_647
  return seed / 2_147_483_647 - 0.5
}

/** A low floor tom: a falling sine with a soft stick. */
function tom(out: Float32Array, at: number, f0: number, level: number): void {
  const s = Math.round(at * SR)
  const n = Math.round(0.32 * SR)
  let ph = 0
  for (let i = 0; i < n && s + i < out.length; i++) {
    const t = i / SR
    const f = f0 * (0.62 + 0.38 * Math.exp(-t / 0.05))
    ph += (2 * Math.PI * f) / SR
    const body = Math.sin(ph) * Math.exp(-t / 0.13)
    const stick = rnd() * Math.exp(-t / 0.004) * 0.5
    if (s + i >= 0) {
      out[s + i] = (out[s + i] ?? 0) + (body + stick) * level * Math.min(1, t / 0.001)
    }
  }
}

/** One-pole filtered noise burst: `hp` high-pass and `lp` low-pass corners, `decay` s. */
function noiseHit(
  out: Float32Array,
  at: number,
  hp: number,
  lp: number,
  decay: number,
  level: number,
): void {
  const s = Math.round(at * SR)
  const n = Math.round(decay * 6 * SR)
  const aL = Math.exp((-2 * Math.PI * lp) / SR)
  const aH = Math.exp((-2 * Math.PI * hp) / SR)
  let l = 0
  let h = 0
  let prev = 0
  for (let i = 0; i < n && s + i < out.length; i++) {
    const t = i / SR
    l = (1 - aL) * rnd() + aL * l
    h = aH * (h + l - prev)
    prev = l
    if (s + i >= 0) {
      out[s + i] = (out[s + i] ?? 0) + h * Math.exp(-t / decay) * level * Math.min(1, t / 0.0008)
    }
  }
}

/**
 * The streak layer: a galloping tom figure on every beat (ONE, and-a), a dry rim knock on 2 and 4
 * and a quiet shaker in eighths, for `seconds` of audio with the bar starting at `downbeat` and
 * beats every `period` s (beats before the downbeat are filled backwards). Stereo: the toms centre,
 * rim slightly left, shaker slightly right.
 */
export function gallop(seconds: number, downbeat: number, period: number): Ch {
  const n = Math.round(seconds * SR)
  const toms = new Float32Array(n)
  const rim = new Float32Array(n)
  const shaker = new Float32Array(n)
  seed = 11
  const k0 = Math.floor(-downbeat / period) - 1
  for (let k = k0; downbeat + k * period < seconds; k++) {
    const t = downbeat + k * period
    const beat = ((k % 4) + 4) % 4
    tom(toms, t, beat === 0 ? 92 : 104, beat === 0 ? 0.9 : 0.6)
    tom(toms, t + period * 0.5, 118, 0.35)
    tom(toms, t + period * 0.75, 118, 0.42)
    if (beat === 1 || beat === 3) {
      noiseHit(rim, t, 900, 3200, 0.025, 0.9)
    }
    noiseHit(shaker, t, 5000, 11_000, 0.018, 0.22)
    noiseHit(shaker, t + period * 0.5, 5000, 11_000, 0.018, 0.32)
  }
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const tm = toms[i] ?? 0
    const r = rim[i] ?? 0
    const sh = shaker[i] ?? 0
    left[i] = tm + r * 0.75 + sh * 0.45
    right[i] = tm + r * 0.45 + sh * 0.75
  }
  return [left, right]
}
