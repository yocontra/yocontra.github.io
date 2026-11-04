// biome-ignore-all lint/complexity/useMaxParams: geometry helpers take positional coordinates (x, y, z, extents), like the three.js builders
/** The courthouse and its clock tower at the end of the street (tools/build-title-art.ts). */
import { circle, FOCAL, gouge, type Pt, poly, proj, ring } from './print.ts'

/* ---------------------------------------------- the courthouse and clock tower */
export const TOWER_Z = 55
export const HALL_Z = 57

/** An elevation point (x across, y up, metres) on a plane facing the viewer at depth z. */
export const at =
  (z: number) =>
  (x: number, y: number): Pt =>
    proj(x, y, z)

export interface Civic {
  /** The tower and hall silhouette (also its halo). */
  body: string[]
  /** Fine black work drawn in the dial. */
  dial: string[]
  carve: string[]
}

export function courthouse(): Civic {
  const t = at(TOWER_Z)
  const hall = at(HALL_Z)
  const body: string[] = []
  const carve: string[] = []
  const dial: string[] = []
  const box = (
    plane: (x: number, y: number) => Pt,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): string => poly([plane(x0, y0), plane(x1, y0), plane(x1, y1), plane(x0, y1)])

  // the hall: plinth, walls, cornice, hipped roof, chimneys
  body.push(box(hall, -9.3, 0, 9.3, 9.6))
  body.push(box(hall, -9.7, 9.5, 9.7, 10.1))
  body.push(poly([hall(-9.5, 10.1), hall(9.5, 10.1), hall(6.6, 12.6), hall(-6.6, 12.6)]))
  for (const cx of [-5.6, 5.6]) {
    body.push(box(hall, cx - 0.45, 11, cx + 0.45, 13.6))
    body.push(box(hall, cx - 0.6, 13.6, cx + 0.6, 13.9))
  }
  for (const side of [-1, 1]) {
    for (const bx of [4.4, 6.4, 8.4]) {
      for (const [y0, y1] of [
        [1.5, 3.8],
        [5.3, 7.8],
      ] as const) {
        const cx = side * bx
        carve.push(box(hall, cx - 0.55, y0, cx + 0.55, y0 + 0.09))
        carve.push(box(hall, cx - 0.55, y1 - 0.09, cx + 0.55, y1))
        carve.push(box(hall, cx - 0.55, y0, cx - 0.47, y1))
        carve.push(box(hall, cx + 0.47, y0, cx + 0.55, y1))
        carve.push(box(hall, cx - 0.04, y0, cx + 0.04, y1))
      }
    }
    carve.push(box(hall, side * 9.3 - 0.5, 1, side * 9.3 + 0.5, 1.07))
  }
  carve.push(box(hall, -9.3, 4.5, 9.3, 4.58))
  carve.push(box(hall, -9.3, 1, 9.3, 1.07))

  // the tower: plinth, brick shaft with quoins, string course, clock stage, cornice
  body.push(box(t, -2.9, 0, 2.9, 1.3))
  body.push(box(t, -2.5, 1.3, 2.5, 12.6))
  for (let y = 1.6; y < 12.4; y += 0.9) {
    const long = Math.round((y - 1.6) / 0.9) % 2 === 0
    for (const side of [-1, 1]) {
      const xa = side * 2.5
      const xb = side * (2.5 - (long ? 0.8 : 0.45))
      carve.push(box(t, Math.min(xa, xb), y, Math.max(xa, xb), y + 0.06))
    }
  }
  body.push(box(t, -2.8, 12.6, 2.8, 13.05))
  body.push(box(t, -2.6, 13.05, 2.6, 16.4))
  body.push(box(t, -2.95, 16.4, 2.95, 16.85))
  carve.push(box(t, -2.8, 12.95, 2.8, 13.02))
  carve.push(box(t, -2.95, 16.75, 2.95, 16.8))
  // the dial at noon: a paper face, a ring, twelve hour marks, both hands up
  const dc = t(0, 14.72)
  const r = (FOCAL * 1.3) / TOWER_Z
  carve.push(circle(dc, r))
  dial.push(ring(dc, r * 0.98, r * 0.86))
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const r0 = i % 3 === 0 ? r * 0.58 : r * 0.68
    const s = Math.sin(a)
    const c = -Math.cos(a)
    dial.push(
      gouge(
        [dc[0] + s * r0, dc[1] + c * r0],
        [dc[0] + s * r * 0.84, dc[1] + c * r * 0.84],
        i % 3 === 0 ? 2.6 : 1.5,
      ),
    )
  }
  dial.push(gouge([dc[0], dc[1] + r * 0.18], [dc[0], dc[1] - r * 0.52], 3.6))
  dial.push(gouge([dc[0], dc[1] + r * 0.24], [dc[0], dc[1] - r * 0.8], 2))
  dial.push(circle(dc, 1.6))
  // the open belfry: piers and round arches, the bell hung in the middle
  body.push(box(t, -2.4, 16.85, -1.75, 19.6))
  body.push(box(t, 1.75, 16.85, 2.4, 19.6))
  body.push(box(t, -2.4, 16.85, 2.4, 17.25))
  const arch: Pt[] = [t(-1.75, 19.6), t(-1.75, 18.55)]
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI - (i / 14) * Math.PI
    arch.push(t(Math.cos(a) * 1.75, 18.55 + Math.sin(a) * 0.95))
  }
  arch.push(t(1.75, 19.6))
  body.push(poly(arch))
  body.push(box(t, -0.08, 18.6, 0.08, 19.5))
  const bell: Pt[] = []
  for (let i = 0; i <= 16; i++) {
    const v = i / 16
    const w = 0.22 + 0.5 * v ** 2.2
    bell.push(t(-w, 18.75 - v * 1.05))
  }
  for (let i = 16; i >= 0; i--) {
    const v = i / 16
    const w = 0.22 + 0.5 * v ** 2.2
    bell.push(t(w, 18.75 - v * 1.05))
  }
  body.push(poly(bell))
  body.push(box(t, -2.75, 19.6, 2.75, 20.05))
  carve.push(box(t, -2.75, 19.68, 2.75, 19.73))
  // the bell-cast spire, its lucarnes, the gilt ball and the weathervane
  const spire: Pt[] = []
  for (let i = 0; i <= 20; i++) {
    const v = i / 20
    spire.push(t(-(2.75 * (1 - v) ** 1.9 + 0.12 * (1 - v)), 20.05 + v * 3.35))
  }
  for (let i = 20; i >= 0; i--) {
    const v = i / 20
    spire.push(t(2.75 * (1 - v) ** 1.9 + 0.12 * (1 - v), 20.05 + v * 3.35))
  }
  body.push(poly(spire))
  body.push(poly([t(-0.55, 20.4), t(0.55, 20.4), t(0.55, 21.1), t(0, 21.55), t(-0.55, 21.1)]))
  carve.push(box(t, -0.36, 20.5, 0.36, 20.56))
  carve.push(box(t, -0.36, 20.68, 0.36, 20.74))
  carve.push(box(t, -0.36, 20.86, 0.36, 20.92))
  body.push(circle(t(0, 23.62), (FOCAL * 0.26) / TOWER_Z))
  body.push(box(t, -0.05, 23.4, 0.05, 25))
  body.push(box(t, -0.65, 24.92, 0.65, 25))
  body.push(box(t, -0.65, 23.98, 0.65, 24.03))
  body.push(poly([t(0.8, 24.48), t(0.42, 24.66), t(0.42, 24.3)]))
  body.push(poly([t(-1.05, 24.46), t(-0.5, 24.46), t(-0.5, 24.52), t(-1.05, 24.52)]))
  body.push(poly([t(-1.2, 24.72), t(-0.85, 24.52), t(-1.2, 24.32), t(-0.95, 24.52)]))
  body.push(box(t, -0.9, 24.47, 0.5, 24.51))
  // the portico in front of the tower door: steps, columns, a pediment
  const p = at(TOWER_Z - 1.2)
  body.push(poly([p(-3.9, 0), p(3.9, 0), p(3.6, 0.6), p(-3.6, 0.6)]))
  body.push(box(p, -3.4, 0.6, 3.4, 5.1))
  body.push(poly([p(-3.8, 5.1), p(3.8, 5.1), p(0, 6.6)]))
  carve.push(box(p, -3.9, 0.18, 3.9, 0.22))
  carve.push(box(p, -3.7, 0.4, 3.7, 0.44))
  carve.push(box(p, -3.4, 4.88, 3.4, 4.95))
  carve.push(
    poly([
      p(-3.05, 5.32),
      p(3.05, 5.32),
      p(0, 6.25),
      p(0, 6.18),
      p(2.55, 5.4),
      p(-2.55, 5.4),
      p(0, 6.18),
      p(0, 6.25),
    ]),
  )
  for (const cx of [-2.75, -0.95, 0.95, 2.75]) {
    carve.push(box(p, cx + 0.22, 0.75, cx + 0.3, 4.75))
  }
  return { body, dial, carve }
}
