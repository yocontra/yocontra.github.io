/**
 * Listen-check by analysis: is each streamed loop's seam click-free?
 *
 *   bun tools/audio/seams.ts [<loop id>…]
 *
 * Decodes each shipped file and looks at its loop end, where the body wraps into the post-roll (the
 * body's first seconds again, which is exactly what the other deck plays after the handover):
 *
 * - `jump`: the sample step across the seam against the 99th-percentile step in the half second
 *   around it (≤ 1 means the seam is no sharper than the music itself);
 * - `Δrms`: the level change from the 50 ms before the seam to the 50 ms after, dB;
 * - `match`: how alike the 200 ms before `end` and the 200 ms before `start` are (normalised
 *   correlation: the loop crossfade makes them converge, so near 1 is a seamless wrap).
 */
import { resolve } from 'node:path'
import { LOOP_POINTS } from '../../src/experiments/out-west/audio/loop-points.ts'
import { load, SR } from './dsp.ts'
import { RECIPES } from './recipes.ts'

const PUB = resolve(import.meta.dir, '../../public/experiments/out-west/3d')

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0
  for (let i = a; i < b; i++) {
    s += (x[i] ?? 0) ** 2
  }
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12)
}

function check(id: string): string {
  const r = RECIPES[id]
  const p = (LOOP_POINTS as Record<string, { start: number; end: number }>)[id]
  if (!(r && p)) {
    return `${id}: no recipe or loop points`
  }
  const ch = load(`${PUB}/${r.out}`, 2)
  const e = Math.round(p.end * SR)
  const s = Math.round(p.start * SR)
  const out: string[] = []
  for (const [ci, x] of ch.entries()) {
    const steps: number[] = []
    for (let i = e - SR / 4; i < e + SR / 4; i++) {
      steps.push(Math.abs((x[i] ?? 0) - (x[i - 1] ?? 0)))
    }
    steps.sort((a, b) => a - b)
    const p99 = steps[Math.floor(steps.length * 0.99)] ?? 1e-9
    const jump = Math.abs((x[e] ?? 0) - (x[e - 1] ?? 0)) / p99
    const drms = rms(x, e, e + SR / 20) - rms(x, e - SR / 20, e)
    const w = SR / 5
    let c = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < w; i++) {
      const a = x[e - w + i] ?? 0
      const b = x[s - w + i] ?? 0
      c += a * b
      na += a * a
      nb += b * b
    }
    const match = s >= w ? c / Math.sqrt(na * nb + 1e-12) : Number.NaN
    out.push(`ch${ci} jump ${jump.toFixed(2)} Δrms ${drms.toFixed(1)} dB match ${match.toFixed(3)}`)
  }
  return `${id.padEnd(16)} ${out.join(' | ')}`
}

const ids = process.argv.slice(2)
for (const id of ids.length > 0 ? ids : Object.keys(LOOP_POINTS)) {
  console.log(check(id))
}
