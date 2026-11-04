// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noMagicNumbers: an arena is a table of measurements, in metres
/**
 * The depot's railroad: the main line (ballast, ties, rails), the cars standing on it (boxcars, a
 * flatcar, the caboose), the water tower over the track and the windmill down the lane.
 */
import { Vector3 } from 'three'
import { type ArenaParts, beam, cyl, placeAt, rod } from './build.ts'

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

/** The main line's centre (x) and its rail heads. */
export const TRACK_X = -12.5
const GAUGE = 0.72
const RAIL_TOP = 0.26
const IRON = 0x3a_36_32

/** One car's trucks: side frames and wheels on the rails. */
function trucks(p: ArenaParts, z: number): void {
  const iron = p.m.cell('tin')
  iron.box(TRACK_X, 0.78, z, 1.9, 0.22, 2.2, IRON)
  for (const dz of [-0.75, 0.75]) {
    for (const s of [-1, 1]) {
      rod(
        iron,
        V(TRACK_X + s * (GAUGE - 0.06), RAIL_TOP + 0.42, z + dz),
        V(TRACK_X + s * (GAUGE + 0.06), RAIL_TOP + 0.42, z + dz),
        0.42,
        10,
        0x2a_28_26,
      )
    }
  }
}

/** A boxcar on the main, from z0 to z1, its door and lettering toward the lane. */
export function boxcar(p: ArenaParts, z0: number, z1: number, color: number, slats: boolean): void {
  const t = p.trim
  const len = z1 - z0
  const zc = (z0 + z1) / 2
  trucks(p, z0 + 1.7)
  trucks(p, z1 - 1.7)
  t.box(TRACK_X, 1.12, zc, 2.7, 0.26, len, 0x2a_22_1e)
  if (slats) {
    // a stock car: dark inside, slats across
    t.box(TRACK_X, 2.6, zc, 2.6, 2.6, len - 0.2, 0x1a_14_10, { skip: ['bottom'] })
    for (let y = 1.4; y < 3.9; y += 0.32) {
      for (const s of [-1, 1]) {
        t.box(TRACK_X + s * 1.33, y, zc, 0.06, 0.18, len - 0.1, color, { rotUV: true })
      }
    }
    for (let z = z0 + 0.3; z < z1; z += 1.2) {
      for (const s of [-1, 1]) {
        t.box(TRACK_X + s * 1.37, 2.6, z, 0.06, 2.6, 0.12, color)
      }
    }
  } else {
    t.box(TRACK_X, 2.6, zc, 2.7, 2.6, len - 0.2, color, { skip: ['bottom'] })
    // the sliding door, its track, and the lettering on the lane side
    t.box(TRACK_X + 1.38, 2.45, zc, 0.06, 2.3, 1.9, color)
    t.box(TRACK_X + 1.4, 3.66, zc, 0.06, 0.08, 4, IRON)
    t.box(TRACK_X + 1.4, 1.28, zc, 0.06, 0.06, 4, IRON)
    p.board(
      { text: 'P. & S.W. R.R.', bg: '#6e2c20', fg: '#ecdcc0' },
      TRACK_X + 1.37,
      3.3,
      zc - 3.1,
      '+x',
      2.4,
      0.42,
    )
  }
  t.box(TRACK_X, 3.98, zc, 2.95, 0.12, len, 0x3a_30_2a)
  t.box(TRACK_X, 4.07, zc, 0.5, 0.06, len - 0.4, 0x6a_58_46, { rotUV: true })
  // ladders at the corners, a brake wheel at the far end
  for (const z of [z0 + 0.12, z1 - 0.12]) {
    for (let y = 1.5; y < 3.9; y += 0.38) {
      t.box(TRACK_X + 1.4, y, z + (z === z0 ? 0.25 : -0.25), 0.05, 0.04, 0.5, IRON)
    }
  }
  rod(p.m.cell('tin'), V(TRACK_X, 3.7, z1 + 0.02), V(TRACK_X, 3.7, z1 + 0.08), 0.32, 10, IRON)
  t.box(TRACK_X, 1.05, z0 - 0.35, 0.3, 0.2, 0.7, IRON)
  t.box(TRACK_X, 1.05, z1 + 0.35, 0.3, 0.2, 0.7, IRON)
}

/** A flatcar loaded with crates and a lumber stack. */
export function flatcar(p: ArenaParts, z0: number, z1: number): void {
  const len = z1 - z0
  const zc = (z0 + z1) / 2
  trucks(p, z0 + 1.5)
  trucks(p, z1 - 1.5)
  p.trim.box(TRACK_X, 1.18, zc, 2.7, 0.32, len, 0x4a_3a_2c, { rotUV: true })
  p.prop('crate', 0.85, 'y', placeAt(TRACK_X - 0.5, 1.34, z0 + 1.2, 0.1, 1.2))
  p.prop('crate', 0.85, 'y', placeAt(TRACK_X + 0.6, 1.34, z0 + 1.4, -0.2, 1.1))
  p.prop('crate', 0.85, 'y', placeAt(TRACK_X, 1.34 + 1.0, z0 + 1.3, 0.4, 0.9))
  for (let i = 0; i < 4; i++) {
    p.trim.box(TRACK_X, 1.42 + i * 0.2, zc + 1.8, 2.2, 0.18, 4.2 - i * 0.3, 0xa0_80_5a, {
      rotUV: true,
    })
  }
}

/** The caboose: red, windowed, a cupola on top and railed platforms at each end. */
export function caboose(p: ArenaParts, z0: number, z1: number): void {
  const t = p.trim
  const len = z1 - z0
  const zc = (z0 + z1) / 2
  const red = 0x8a_2a_1c
  trucks(p, z0 + 1.6)
  trucks(p, z1 - 1.6)
  t.box(TRACK_X, 1.12, zc, 2.7, 0.26, len, 0x2a_22_1e)
  t.box(TRACK_X, 2.5, zc, 2.6, 2.5, len - 1.8, red, { skip: ['bottom'] })
  t.box(TRACK_X, 3.8, zc, 2.9, 0.1, len - 1.4, 0x3a_30_2a)
  t.box(TRACK_X, 4.3, zc, 1.9, 0.9, 2, red)
  t.box(TRACK_X, 4.8, zc, 2.2, 0.1, 2.3, 0x3a_30_2a)
  for (const s of [-1, 1]) {
    for (const dz of [-1.6, 0, 1.6]) {
      p.glass.box(TRACK_X + s * 1.31, 2.7, zc + dz, 0.04, 0.6, 0.55, 0xff_ff_ff)
    }
    p.glass.box(TRACK_X + s * 0.96, 4.35, zc, 0.04, 0.4, 1.2, 0xff_ff_ff)
  }
  // the end platforms' rails and the stove pipe
  for (const z of [z0 + 0.4, z1 - 0.4]) {
    t.box(TRACK_X, 2.1, z, 2.5, 0.06, 0.06, IRON)
    for (const s of [-1, 1]) {
      t.box(TRACK_X + s * 1.22, 1.7, z, 0.05, 0.9, 0.05, IRON)
    }
  }
  cyl(p.m.cell('tin'), TRACK_X - 0.6, 3.85, zc + 1.6, 0.09, 0.09, 0.8, 8, 0x2a_26_22)
  p.board(
    { text: 'P. & S.W.', bg: '#8a2a1c', fg: '#f0dcb0' },
    TRACK_X + 1.32,
    3.2,
    zc + 0.8,
    '+x',
    1.4,
    0.3,
  )
}

/** The main line: ballast, ties and rails, from behind the player to the horizon. */
export function track(p: ArenaParts): void {
  const z0 = -150
  const z1 = 230
  p.adobe.box(TRACK_X, 0.05, (z0 + z1) / 2, 3.6, 0.1, z1 - z0, 0x8a_80_72, { skip: ['bottom'] })
  for (let z = z0 + 0.4; z < z1; z += 0.72) {
    p.trim.box(TRACK_X, 0.13, z, 2.5, 0.06, 0.24, 0x4a_3c_30)
  }
  const steel = p.m.cell('tin')
  for (const s of [-1, 1]) {
    steel.box(TRACK_X + s * GAUGE, RAIL_TOP - 0.05, (z0 + z1) / 2, 0.07, 0.1, z1 - z0, 0x7a_74_6e)
  }
  // a stack of new ties by the line, a mail crane, a wagon waiting at the freight house
  for (let k = 0; k < 5; k++) {
    for (let j = 0; j < 4 - (k % 2); j++) {
      p.trim.box(
        -9.5 + (k % 2) * 0.15,
        0.09 + k * 0.17,
        33.6 + j * 0.3,
        2.5,
        0.16,
        0.24,
        0x5a_48_36,
      )
    }
  }
  const mc = { x: -10.7, z: 41 }
  p.trim.box(mc.x, 2.2, mc.z, 0.2, 4.4, 0.2, 0x4a_38_28)
  for (const y of [2.6, 3.9]) {
    p.trim.box(mc.x + 0.45, y, mc.z, 0.9, 0.1, 0.1, 0x4a_38_28)
  }
  p.trim.box(mc.x + 0.85, 3.25, mc.z, 0.4, 1.0, 0.4, 0x8a_74_56)
  p.prop('cart', 3.8, 'max', placeAt(7.2, 0, 40.5, 0.12))
  p.prop('barrel', 0.95, 'y', placeAt(-9.2, 0, 22.5, 0.7))
  p.prop('crate', 0.85, 'y', placeAt(-9.3, 0, 21.4, 0.2))
  // the switch stand by the yard, its lamp
  p.trim.box(-10.4, 0.7, 6, 0.12, 1.4, 0.12, IRON)
  p.prop('lantern', 0.45, 'y', placeAt(-10.4, 1.4, 6), false)
}

/** The water tower over the track: timber legs and bracing, stave tank, iron hoops, the spout. */
export function waterTower(p: ArenaParts, x: number, z: number): void {
  const t = p.trim
  const legs = [
    [-2.2, -2.2],
    [2.2, -2.2],
    [-2.2, 2.2],
    [2.2, 2.2],
  ] as const
  for (const [dx, dz] of legs) {
    beam(t, V(x + dx * 1.12, 0, z + dz * 1.12), V(x + dx, 8.2, z + dz), 0.36, 0.36, 0x4a_38_28)
    t.box(x + dx * 1.12, 0.2, z + dz * 1.12, 0.7, 0.4, 0.7, 0x8a_80_72)
  }
  for (const y of [2.6, 5.4]) {
    for (const [a, b] of [
      [0, 1],
      [1, 3],
      [3, 2],
      [2, 0],
    ] as const) {
      const A = legs[a]
      const B = legs[b]
      const k = 1.12 - (y / 8.2) * 0.12
      beam(
        t,
        V(x + A[0] * k, y, z + A[1] * k),
        V(x + B[0] * k, y, z + B[1] * k),
        0.16,
        0.2,
        0x4a_38_28,
      )
      beam(
        t,
        V(x + A[0] * k, y, z + A[1] * k),
        V(x + B[0] * (k - 0.03), y + 2.6, z + B[1] * (k - 0.03)),
        0.1,
        0.1,
        0x4a_38_28,
      )
    }
  }
  t.box(x, 8.3, z, 5.6, 0.24, 5.6, 0x3a_2c_20)
  cyl(t, x, 8.42, z, 2.75, 2.75, 3.9, 18, 0x6e_50_36)
  const iron = p.m.cell('tin')
  for (const y of [8.9, 9.8, 10.7, 11.6]) {
    cyl(iron, x, y, z, 2.79, 2.79, 0.07, 18, 0x2a_26_22, false)
  }
  cyl(t, x, 12.32, z, 3.0, 0.15, 1.5, 18, 0x4a_3a_2c)
  // the spout swung toward the line, its chain and counterweight
  const sx = x + 2.7
  rod(iron, V(sx, 9.3, z), V(TRACK_X - 0.2, 6.9, z), 0.2, 8, 0x3a_34_30)
  beam(iron, V(TRACK_X - 0.1, 6.9, z), V(TRACK_X - 0.1, 8.9, z), 0.03, 0.03, 0x1e_1c_1a)
  iron.box(TRACK_X - 0.1, 9.3, z, 0.25, 0.5, 0.25, 0x2a_26_22)
}

/** A steel windmill on its lattice tower, the wheel turned toward the lane. */
export function windmill(p: ArenaParts, x: number, z: number): void {
  const iron = p.m.cell('tin')
  const h = 11.5
  const c = 0x5a_56_52
  const base = 1.7
  const top = 0.3
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const
  for (const [dx, dz] of corners) {
    beam(iron, V(x + dx * base, 0, z + dz * base), V(x + dx * top, h, z + dz * top), 0.08, 0.08, c)
  }
  for (let i = 1; i < 5; i++) {
    const y = (i / 5) * h
    const k = base + (top - base) * (i / 5)
    for (let j = 0; j < 4; j++) {
      const A = corners[j] as readonly [number, number]
      const B = corners[(j + 1) % 4] as readonly [number, number]
      beam(iron, V(x + A[0] * k, y, z + A[1] * k), V(x + B[0] * k, y, z + B[1] * k), 0.05, 0.05, c)
    }
  }
  const hy = h + 0.5
  iron.box(x, hy, z, 0.4, 0.4, 0.9, 0x3a_36_32)
  // the wheel, facing -z (down the lane, toward the camera)
  const hub = V(x, hy, z - 0.6)
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2
    const r0 = 0.5
    const r1 = 2.4
    beam(
      iron,
      hub.clone().add(V(Math.cos(a) * r0, Math.sin(a) * r0, 0)),
      hub.clone().add(V(Math.cos(a) * r1, Math.sin(a) * r1, 0)),
      0.32,
      0.02,
      0x8a_84_7a,
    )
  }
  // the tail vane out behind
  beam(iron, V(x, hy, z + 0.3), V(x, hy, z + 2.6), 0.05, 0.05, c)
  iron.box(x, hy + 0.2, z + 2.8, 0.03, 1.1, 1.6, 0x8a_84_7a)
  // a tank at its foot
  cyl(p.trim, x + 2.8, 0, z + 1.5, 1.8, 1.8, 1.0, 16, 0x5a_4a_3a)
}
