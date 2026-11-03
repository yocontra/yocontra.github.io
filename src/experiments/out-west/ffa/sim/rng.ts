/** Deterministic PRNG and hashing for the Frontier sim. Same seed, same sequence, on every engine. */

/** mulberry32. State is a u32; `next()` returns [0, 1). */
export class Rng {
  state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d_2b_79_f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }
}

/** Hash a few u32s into one (per-shot spread seeds that don't consume world RNG). */
export function hash32(...parts: readonly number[]): number {
  let h = 0x81_1c_9d_c5
  for (const p of parts) {
    h ^= p >>> 0
    h = Math.imul(h, 0x01_00_01_93)
    h ^= h >>> 13
  }
  return h >>> 0
}

/** Hash to [-1, 1). */
export const hashSigned = (...parts: readonly number[]): number =>
  (hash32(...parts) / 4_294_967_296) * 2 - 1
