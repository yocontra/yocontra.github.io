// biome-ignore-all lint/complexity/useMaxParams: DSP helpers take positional numeric args (frequencies, times, levels), like ffmpeg filters
/**
 * Loop-point search for through-composed music (the 2019 title and boss themes end in a fade, so
 * looping the whole file leaves a gap). Finds the pair (start, end) whose next few seconds sound
 * most alike, with end − start at least `minLen`, then aligns `end` to `start` at sample level by
 * cross-correlation so the crossfade sums in phase.
 */
import { type Ch, mono, SR } from './dsp.ts'

const HOP = 0.1
const N = 4096
const BANDS = 36

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) {
      j ^= bit
    }
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0]
      ;[im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = a + size / 2
        const xr = (re[b] ?? 0) * wr - (im[b] ?? 0) * wi
        const xi = (re[b] ?? 0) * wi + (im[b] ?? 0) * wr
        re[b] = (re[a] ?? 0) - xr
        im[b] = (im[a] ?? 0) - xi
        re[a] = (re[a] ?? 0) + xr
        im[a] = (im[a] ?? 0) + xi
      }
    }
  }
}

/** Log-band spectra every HOP seconds, each frame zero-mean and unit-norm. */
function features(x: Float32Array): Float32Array[] {
  const hop = Math.round(HOP * SR)
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => 60 * (12_000 / 60) ** (i / BANDS))
  const frames: Float32Array[] = []
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let at = 0; at + N <= x.length; at += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = (x[at + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
      im[i] = 0
    }
    fft(re, im)
    const f = new Float32Array(BANDS)
    for (let b = 0; b < BANDS; b++) {
      const lo = Math.floor(((edges[b] ?? 0) * N) / SR)
      const hi = Math.max(lo + 1, Math.floor(((edges[b + 1] ?? 0) * N) / SR))
      let e = 0
      for (let k = lo; k < hi; k++) {
        e += (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2
      }
      f[b] = Math.log10(e / (hi - lo) + 1e-9)
    }
    const mean = f.reduce((a, v) => a + v, 0) / BANDS
    let norm = 0
    for (let b = 0; b < BANDS; b++) {
      f[b] = (f[b] ?? 0) - mean
      norm += (f[b] ?? 0) ** 2
    }
    const k = 1 / Math.sqrt(norm + 1e-12)
    frames.push(f.map((v) => v * k))
  }
  return frames
}

export interface LoopPoints {
  start: number
  end: number
  score: number
}

/**
 * The best of the given (start, end) candidates (seconds), for rhythmic music whose loop must be a
 * whole number of bars: scored like `findLoop` (at the nearest analysis hop), then `end` is
 * aligned to the waveform by at most ±60 ms.
 */
export function findLoopAmong(
  ch: Ch,
  pairs: readonly (readonly [number, number])[],
  win = 4,
): LoopPoints {
  const x = mono(ch)[0] ?? new Float32Array(0)
  const fr = features(x)
  const w = Math.round(win / HOP)
  let best: LoopPoints = { start: 0, end: 0, score: -2 }
  for (const [start, end] of pairs) {
    const a = Math.round(start / HOP)
    const b = Math.round(end / HOP)
    let s = 0
    let ok = true
    for (let k = 0; k < w && ok; k++) {
      const fa = fr[a + k]
      const fb = fr[b + k]
      if (fa && fb) {
        for (let i = 0; i < BANDS; i++) {
          s += (fa[i] ?? 0) * (fb[i] ?? 0)
        }
      } else {
        ok = false
      }
    }
    if (ok && s / w > best.score) {
      best = { start, end, score: s / w }
    }
  }
  return { ...best, end: align(x, best.start, best.end) }
}

/** Search starts in [sMin, sMax] and ends in [start + minLen, eMax] (seconds). */
export function findLoop(
  ch: Ch,
  sMin: number,
  sMax: number,
  minLen: number,
  eMax: number,
  win = 4,
): LoopPoints {
  const x = mono(ch)[0] ?? new Float32Array(0)
  const fr = features(x)
  const w = Math.round(win / HOP)
  const sim = (a: number, b: number) => {
    let s = 0
    for (let k = 0; k < w; k++) {
      const fa = fr[a + k]
      const fb = fr[b + k]
      if (!(fa && fb)) {
        return -1
      }
      let d = 0
      for (let i = 0; i < BANDS; i++) {
        d += (fa[i] ?? 0) * (fb[i] ?? 0)
      }
      s += d
    }
    return s / w
  }
  let best: LoopPoints = { start: 0, end: 0, score: -2 }
  const s0 = Math.round(sMin / HOP)
  const s1 = Math.round(sMax / HOP)
  const e1 = Math.min(fr.length - w, Math.round(eMax / HOP))
  for (let s = s0; s <= s1; s++) {
    for (let e = s + Math.round(minLen / HOP); e <= e1; e++) {
      const score = sim(s, e)
      if (score > best.score) {
        best = { start: s * HOP, end: e * HOP, score }
      }
    }
  }
  return { ...best, end: align(x, best.start, best.end) }
}

/** Shift `end` by up to ±60 ms to best match the waveform at `start` (normalised cross-correlation). */
function align(x: Float32Array, start: number, end: number): number {
  const s = Math.round(start * SR)
  const e = Math.round(end * SR)
  const span = Math.round(0.25 * SR)
  const range = Math.round(0.06 * SR)
  let best = 0
  let bestC = Number.NEGATIVE_INFINITY
  for (let d = -range; d <= range; d++) {
    let c = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < span; i += 2) {
      const a = x[s + i] ?? 0
      const b = x[e + d + i] ?? 0
      c += a * b
      na += a * a
      nb += b * b
    }
    const r = c / Math.sqrt(na * nb + 1e-12)
    if (r > bestC) {
      bestC = r
      best = d
    }
  }
  return (e + best) / SR
}
