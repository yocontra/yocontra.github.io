// biome-ignore-all lint/complexity/useMaxParams: geometry helpers take positional coordinates (x, y, z, extents), like the three.js builders
/** The duel street's false fronts, porches and boardwalks in perspective (tools/build-title-art.ts). */
import { FOCAL, gouge, jitter, poly, proj, rect, wallQuad } from './print.ts'

/* --------------------------------------------------------------- the street */
export type Top = 'flat' | 'step' | 'peak' | 'arch'
export interface Front {
  z0: number
  z1: number
  h: number
  top: Top
  /** A second storey with a gallery. */
  upper?: boolean
}
export const LEFT: Front[] = [
  { z0: 5.5, z1: 12.6, h: 8.6, top: 'step', upper: true },
  { z0: 12.6, z1: 18.8, h: 6.4, top: 'flat' },
  { z0: 19.2, z1: 24.4, h: 7.8, top: 'peak', upper: true },
  { z0: 24.4, z1: 29.6, h: 5.6, top: 'flat' },
  { z0: 30.6, z1: 36, h: 5.4, top: 'arch' },
  { z0: 36, z1: 41.2, h: 4.6, top: 'flat' },
  { z0: 41.6, z1: 47.4, h: 4.8, top: 'step' },
]
export const RIGHT: Front[] = [
  { z0: 5.5, z1: 13.4, h: 9.4, top: 'flat', upper: true },
  { z0: 13.4, z1: 18.4, h: 6, top: 'arch' },
  { z0: 18.4, z1: 25, h: 7.4, top: 'step', upper: true },
  { z0: 25.8, z1: 30.4, h: 5.2, top: 'flat' },
  { z0: 30.4, z1: 36.6, h: 5.4, top: 'peak' },
  { z0: 36.6, z1: 41.6, h: 4.6, top: 'step' },
  { z0: 42.4, z1: 47.4, h: 4.8, top: 'flat' },
]
export const FACADE = 8
export const WALK = 6
export const WALK_H = 0.35
export const PORCH_IN = 3.15
export const PORCH_OUT = 2.8

/** The false front's outline, in (z, y) on the wall plane. */
export function frontOutline(f: Front): [number, number][] {
  const { z0, z1, h } = f
  const span = z1 - z0
  const mid = (z0 + z1) / 2
  if (f.top === 'step') {
    const a = z0 + span * 0.26
    const b = z1 - span * 0.26
    return [
      [z0, 0],
      [z1, 0],
      [z1, h],
      [b, h],
      [b, h + 0.9],
      [a, h + 0.9],
      [a, h],
      [z0, h],
    ]
  }
  if (f.top === 'peak') {
    return [
      [z0, 0],
      [z1, 0],
      [z1, h],
      [mid, h + 1.3],
      [z0, h],
    ]
  }
  if (f.top === 'arch') {
    const pts: [number, number][] = [
      [z0, 0],
      [z1, 0],
      [z1, h],
    ]
    for (let i = 1; i < 12; i++) {
      const t = i / 12
      pts.push([z1 - span * t, h + Math.sin(t * Math.PI) ** 0.7 * 1.1])
    }
    pts.push([z0, h])
    return pts
  }
  return [
    [z0, 0],
    [z1, 0],
    [z1, h],
    [z0, h],
  ]
}

export interface Street {
  red: string[]
  black: string[]
  /** Carved out of the red: rim light, boardwalk planks. */
  carveRed: string[]
  /** Carved out of the black: window and door frames (red shows through). */
  carveBlack: string[]
  /** The facade silhouettes (they hide whatever stands behind them). */
  occluders: string[]
}

export function buildFront(f: Front, side: 1 | -1, out: Street): void {
  const x = side * FACADE
  const outline = poly(frontOutline(f).map(([z, y]) => proj(x, y, z)))
  out.red.push(outline)
  out.occluders.push(outline)
  const { z0, z1, h } = f
  const span = z1 - z0
  // cornice: a black band with a carved bead under it
  out.black.push(poly(wallQuad(x, z0, z1, h - 0.42, h - 0.1)))
  out.carveRed.push(poly(wallQuad(x, z0 + 0.15, z1 - 0.15, h - 0.6, h - 0.52)))
  // rim light: the backlit far edge of each front
  out.carveRed.push(poly(wallQuad(x, z1 - 0.32, z1 - 0.2, 0.4, h - 0.6)))
  // the porch: its shade on the wall, the roof, posts and the boardwalk
  out.black.push(poly(wallQuad(x, z0, z1, WALK_H, PORCH_IN)))
  const xo = side * (WALK + 0.1)
  out.black.push(
    poly([
      proj(x, PORCH_IN, z0),
      proj(x, PORCH_IN, z1),
      proj(xo, PORCH_OUT, z1),
      proj(xo, PORCH_OUT, z0),
    ]),
  )
  out.black.push(poly(wallQuad(xo, z0, z1, PORCH_OUT - 0.26, PORCH_OUT)))
  const posts = Math.max(1, Math.round(span / 3.1))
  for (let i = 0; i <= posts; i++) {
    const z = z0 + 0.15 + ((span - 0.3) * i) / posts
    const a = proj(xo, WALK_H, z)
    const b = proj(xo, PORCH_OUT, z)
    const w = Math.max(1.2, (FOCAL * 0.16) / z)
    out.black.push(poly(rect(a[0] - w / 2, b[1], a[0] + w / 2, a[1])))
    out.carveBlack.push(
      poly(
        rect(
          a[0] + (side > 0 ? -w / 2 - 0.9 : w / 2),
          b[1] + 2,
          a[0] + (side > 0 ? -w / 2 : w / 2 + 0.9),
          a[1] - 1,
        ),
      ),
    )
  }
  // boardwalk: the top in red with carved plank seams, a black face to the street
  out.red.push(
    poly([
      proj(x, WALK_H, z0),
      proj(x, WALK_H, z1),
      proj(side * WALK, WALK_H, z1),
      proj(side * WALK, WALK_H, z0),
    ]),
  )
  out.black.push(poly(wallQuad(side * WALK, z0, z1, 0, WALK_H)))
  for (let z = z0 + 0.5; z < z1 - 0.2; z += 0.62) {
    const a = proj(side * (FACADE - 0.1), WALK_H, z)
    const b = proj(side * (WALK + 0.05), WALK_H, z + 0.02)
    out.carveRed.push(gouge(a, b, Math.max(0.6, 7 / z)))
  }
  // door and windows under the porch: carved frames on the black (the red shows through)
  const door = z0 + span * (0.35 + jitter(0.08))
  frame(out, x, door, door + 1.15, WALK_H + 0.05, 2.55)
  for (const t of [0.12, 0.66]) {
    const zw = z0 + span * t
    if (zw + 1.2 < z1 - 0.3) {
      frame(out, x, zw, zw + 1.2, 1.05, 2.45)
    }
  }
  // upper windows: black panes on the red, a carved sash bar
  if (h > 5.4) {
    const count = Math.max(1, Math.round(span / 2.6))
    for (let i = 0; i < count; i++) {
      const zc = z0 + (span * (i + 0.5)) / count
      const top = Math.min(h - 0.9, f.upper ? 5.7 : 5.3)
      out.black.push(poly(wallQuad(x, zc - 0.5, zc + 0.5, 3.9, top)))
      out.carveBlack.push(poly(wallQuad(x, zc - 0.04, zc + 0.04, 4, top - 0.1)))
      out.carveBlack.push(
        poly(wallQuad(x, zc - 0.45, zc + 0.45, (3.9 + top) / 2 - 0.04, (3.9 + top) / 2 + 0.04)),
      )
    }
  }
  // a gallery rail across the upper storey
  if (f.upper) {
    out.black.push(poly(wallQuad(xo, z0, z1, 4.15, 4.3)))
    for (let z = z0 + 0.4; z < z1; z += 0.55) {
      const a = proj(xo, PORCH_OUT, z)
      const b = proj(xo, 4.2, z)
      out.black.push(gouge(a, b, Math.max(0.5, 5 / z)))
    }
  }
}

export function frame(
  out: Street,
  x: number,
  za: number,
  zb: number,
  y0: number,
  y1: number,
): void {
  const t = 0.05
  out.carveBlack.push(poly(wallQuad(x, za, za + t * 2, y0, y1)))
  out.carveBlack.push(poly(wallQuad(x, zb - t * 2, zb, y0, y1)))
  out.carveBlack.push(poly(wallQuad(x, za, zb, y1 - t, y1 + t)))
  out.carveBlack.push(poly(wallQuad(x, za, zb, (y0 + y1) / 2 + 0.1, (y0 + y1) / 2 + 0.16)))
}

export function street(): Street {
  const out: Street = { red: [], black: [], carveRed: [], carveBlack: [], occluders: [] }
  for (const [list, side] of [
    [LEFT, -1],
    [RIGHT, 1],
  ] as const) {
    for (const f of [...list].reverse()) {
      buildFront(f, side, out)
    }
  }
  return out
}
