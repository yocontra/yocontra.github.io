// biome-ignore-all lint/complexity/useMaxParams: geometry helpers take positional coordinates (x, y, z, extents), like the three.js builders
/** The title print's camera, plates and drawing helpers (tools/build-title-art.ts). */
export type Pt = readonly [number, number]

export const W = 1400
export const H = 640
export const VPX = 700
export const HORIZON = 420
export const FOCAL = 760
export const EYE = 1.15
export const RED = '#a8241b'
export const INK = '#1d140c'

/** Seeded PRNG (mulberry32): the print is identical on every build. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return (): number => {
    s = (s + 0x6d_2b_79_f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
export const rand = rng(1879)
export const jitter = (amount: number): number => (rand() - 0.5) * 2 * amount

export const n1 = (v: number): string => {
  const r = Math.round(v * 10) / 10
  return Object.is(r, -0) ? '0' : String(r)
}

/** World (x right, y up, z into the screen, metres) to the print. */
export function proj(x: number, y: number, z: number): Pt {
  return [VPX + (FOCAL * x) / z, HORIZON - (FOCAL * (y - EYE)) / z]
}

export function poly(pts: readonly Pt[]): string {
  return `M${pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join('L')}Z`
}

export function rect(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}

/** A quad on a street-facing wall (x fixed): z0..z1 along the street, y0..y1 up. */
export function wallQuad(x: number, z0: number, z1: number, y0: number, y1: number): Pt[] {
  return [proj(x, y0, z0), proj(x, y0, z1), proj(x, y1, z1), proj(x, y1, z0)]
}

/** A tapered gouge: a lens between two points, widest in the middle. */
export function gouge(a: Pt, b: Pt, width: number): string {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * width * 0.5
  const ny = (dx / len) * width * 0.5
  const m1: Pt = [a[0] + dx * 0.3, a[1] + dy * 0.3]
  const m2: Pt = [a[0] + dx * 0.7, a[1] + dy * 0.7]
  return poly([
    a,
    [m1[0] + nx, m1[1] + ny],
    [m2[0] + nx, m2[1] + ny],
    b,
    [m2[0] - nx, m2[1] - ny],
    [m1[0] - nx, m1[1] - ny],
  ])
}

export function circle([cx, cy]: Pt, r: number): string {
  return `M${n1(cx - r)} ${n1(cy)}a${n1(r)} ${n1(r)} 0 1 0 ${n1(r * 2)} 0a${n1(r)} ${n1(r)} 0 1 0 ${n1(-r * 2)} 0Z`
}
export function ring(c: Pt, r0: number, r1: number): string {
  // even-odd: the inner circle drawn the other way round
  const [cx, cy] = c
  return `${circle(c, r0)}M${n1(cx - r1)} ${n1(cy)}a${n1(r1)} ${n1(r1)} 0 1 1 ${n1(r1 * 2)} 0a${n1(r1)} ${n1(r1)} 0 1 1 ${n1(-r1 * 2)} 0Z`
}
