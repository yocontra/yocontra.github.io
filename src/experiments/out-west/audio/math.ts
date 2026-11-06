/** Small audio maths shared by the engine: gains, glides, caption keys and the limiter curve. */

export const taper = (x: number): number => x * x

export const db = (d: number): number => 10 ** (d / 20)

export const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Click-free parameter change: hold whatever value the param has right now (mid-ramp included)
 * and glide exponentially toward the target. Never reads `.value` (which can lag the audio
 * thread) and never jumps.
 */
export function glide(p: AudioParam, target: number, now: number, seconds: number): void {
  if (!(Number.isFinite(target) && Number.isFinite(now) && Number.isFinite(seconds))) {
    return
  }
  const hold = (p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam })
    .cancelAndHoldAtTime
  if (hold) {
    hold.call(p, now)
  } else {
    p.cancelScheduledValues(now)
    p.setValueAtTime(p.value, now)
  }
  p.setTargetAtTime(target, now, Math.max(0.01, seconds / 4))
}

const NOT_WORD = /[^\p{L}\p{N}]+/gu

/** A caption reduced to its words, so a stray quote mark or ellipsis never loses its voice. */
export function lineKey(text: string): string {
  return text.normalize('NFKD').toLowerCase().replaceAll(NOT_WORD, ' ').trim()
}

/**
 * Soft-clip transfer curve over the WaveShaper's -1..1 input domain: exact identity up to 0.8,
 * then a tanh knee. The limiter sits at -2 dBFS (≈0.79), so in normal play the knee is never
 * reached.
 */
export function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4097
  const knee = 0.8
  const room = 1 - knee
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room)
    curve[i] = Math.sign(x) * y
  }
  return curve
}
