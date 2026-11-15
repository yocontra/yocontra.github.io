/**
 * The grids Frontier's gridded sound files are laid out on, and the slicing helpers the Frontier
 * recipes share. Gridded files hold `count` variants `step` s apart, which the client slices with
 * native sound slots (`client/frontier-sounds.ts` mirrors these numbers).
 */
import { resolve } from 'node:path'
import {
  type Ch,
  events,
  fade,
  filt,
  gain,
  linToDb,
  load,
  mixInto,
  onset,
  peak,
  silence,
  slice,
} from './dsp.ts'

const PUB = resolve(import.meta.dir, '../../public/experiments/out-west/3d/sfx')
export const shipped = (name: string) => `${PUB}/${name}.m4a`

export const FRONTIER_GRIDS = {
  hit_flesh: { count: 8, step: 0.5, len: 0.42 },
  hit_stone: { count: 8, step: 0.6, len: 0.55 },
  hit_metal: { count: 8, step: 0.9, len: 0.85 },
  hit_water: { count: 8, step: 0.7, len: 0.6 },
  hit_soft: { count: 8, step: 0.5, len: 0.4 },
  hit_timber: { count: 8, step: 0.6, len: 0.5 },
  hit_ground: { count: 8, step: 0.6, len: 0.5 },
  steps_boards: { count: 10, step: 0.5, len: 0.42 },
  steps_dirt: { count: 8, step: 0.6, len: 0.5 },
  steps_stone: { count: 8, step: 0.5, len: 0.4 },
  steps_straw: { count: 8, step: 0.5, len: 0.4 },
  steps_metal: { count: 6, step: 0.7, len: 0.6 },
  steps_water: { count: 8, step: 0.7, len: 0.6 },
  foley_cloth: { count: 6, step: 0.6, len: 0.5 },
  foley_reload: { count: 6, step: 0.8, len: 0.75 },
  crack: { count: 6, step: 0.5, len: 0.42 },
  sign_creak: { count: 5, step: 2, len: 1.9 },
  shots_revolver: { count: 8, step: 0.8, len: 0.75 },
  bodyfalls: { count: 6, step: 1.7, len: 1.6 },
  tails_street: { count: 6, step: 2.4, len: 2.3 },
} as const

export type GridName = keyof typeof FRONTIER_GRIDS

export const norm = (ch: Ch, db = 0) => gain(ch, db - linToDb(peak(ch)))
export const rate = (ch: Ch, r: number) =>
  r === 1 ? ch : filt(ch, `asetrate=${Math.round(48_000 * r)},aresample=48000`)

/** From just before the attack, `len` s, faded out. */
export function cut(ch: Ch, len: number, rel = -30, at = 0): Ch {
  const tail = slice(ch, at)
  const o = Math.max(0, onset(tail, rel) - 0.003)
  return fade(slice(tail, o, o + len), 0.002, Math.min(0.2, len * 0.45))
}

/** RMS over the first `window` s, dB: what a short transient's loudness reads as. */
function headRms(ch: Ch, window: number): number {
  const m = ch[0] ?? new Float32Array(0)
  const n = Math.min(m.length, Math.round(window * 48_000))
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += (m[i] ?? 0) ** 2
  }
  return 10 * Math.log10(sum / Math.max(1, n) + 1e-12)
}

/**
 * Lay variants on their grid, each faded inside its slot. `level` 'peak' normalises each variant's
 * peak; 'rms' matches their opening loudness instead (for takes with very different crest factors,
 * like gunshots), so no variant jumps out of a volley.
 */
export function gridOf(name: GridName, list: readonly Ch[], level: 'peak' | 'rms' = 'peak'): Ch {
  const g = FRONTIER_GRIDS[name]
  if (list.length !== g.count) {
    throw new Error(`${name}: ${list.length} variants for a grid of ${g.count}`)
  }
  const shaped = list.map((v) => fade(slice(v, 0, g.len), 0.002, g.len * 0.35))
  const rms = shaped.map((v) => headRms(v, Math.min(0.25, g.len)))
  const quietest = Math.min(...rms)
  const levelled =
    level === 'rms' ? shaped.map((v, i) => gain(v, quietest - (rms[i] ?? quietest))) : shaped
  const top = level === 'rms' ? Math.max(...levelled.map((v) => peak(v))) : 0
  let out = silence(g.step * g.count, 1)
  levelled.forEach((v, i) => {
    const one = level === 'rms' ? gain(v, -1 - linToDb(top)) : norm(v, -1)
    out = mixInto(out, one, i * g.step)
  })
  return out
}

/** `n` separate events of a performance at least `gap` s apart, each `len` s from its attack. */
export function sliced(ch: Ch, n: number, take: { len: number; gap: number; rel?: number }): Ch[] {
  return events(ch, n, take.gap, take.rel ?? -24).map((t) =>
    slice(ch, Math.max(0, t - 0.006), t + take.len),
  )
}

/** The variants of an already-gridded shipped file, as separate takes. */
export function ungrid(file: string, count: number, step: number, len: number): Ch[] {
  const all = load(shipped(file), 1)
  return Array.from({ length: count }, (_, i) => slice(all, i * step, i * step + len))
}

/** A coat swish: band-limited noise swelling over ~40 ms and dying away, no hard transient. */
export function swish(seconds: number, seed0: number): Ch {
  const n = Math.round(seconds * 48_000)
  const out = new Float32Array(n)
  let seed = seed0
  for (let i = 0; i < n; i++) {
    seed = (seed * 16_807) % 2_147_483_647
    const t = i / 48_000
    out[i] = (seed / 2_147_483_647 - 0.5) * Math.min(1, t / 0.04) * Math.exp(-t / (seconds * 0.3))
  }
  return filt([out], 'highpass=f=700,lowpass=f=3800,highpass=f=700,lowpass=f=3800')
}
