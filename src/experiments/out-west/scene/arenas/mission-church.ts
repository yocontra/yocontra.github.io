// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noMagicNumbers: an arena is a table of measurements, in metres
/**
 * The mission church across the head of the plaza: a limestone front with its carved doorway,
 * niches and choir window, the curved bell gable with three bells and a cross, the nave behind,
 * and the bell tower at its shoulder.
 */
import { ExtrudeGeometry, Path, Shape, Vector3 } from 'three'
import { wallFrame } from '../masonry.ts'
import { type ArenaParts, cyl } from './build.ts'

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

/** The church front's plane (it faces -z, down the lane) and its half width. */
export const FRONT_Z = 52
const HALF = 6.5
const WALL_H = 9.6
const LIMESTONE = 0xf2_e6_d4
const PLASTER = 0xf0_dc_c4
const BEAM = 0x5a_42_30
const IRON = 0x2a_26_22

/** An arched hole, `w` wide, from `y0` to its springing line `spring`, centred on x. */
function archHole(x: number, y0: number, spring: number, w: number): Path {
  const p = new Path()
  const r = w / 2
  p.moveTo(x - r, y0)
  p.lineTo(x + r, y0)
  p.lineTo(x + r, spring)
  p.absarc(x, spring, r, 0, Math.PI, false)
  p.closePath()
  return p
}

/**
 * The church front in local units (x across from the left corner, y up): the wall with its door
 * notched in, rising in a curved gable with three bell arches, a round choir window below them.
 */
function frontShape(): Shape {
  const s = new Shape()
  const W = HALF * 2
  const c = HALF
  s.moveTo(0, 0)
  s.lineTo(c - 1.4, 0)
  s.lineTo(c - 1.4, 3.2)
  s.absarc(c, 3.2, 1.4, Math.PI, 0, true)
  s.lineTo(c + 1.4, 0)
  s.lineTo(W, 0)
  s.lineTo(W, WALL_H)
  // the shoulders, then the gable's curve up to its round crown
  const right: [number, number][] = [
    [4.7, WALL_H],
    [4.7, 10.4],
    [3.7, 10.9],
    [2.95, 12.0],
    [2.25, 13.3],
    [1.6, 14.3],
  ]
  for (const [x, y] of right) {
    s.lineTo(c + x, y)
  }
  s.absarc(c, 14.3, 1.6, 0, Math.PI, false)
  for (const [x, y] of [...right].reverse()) {
    s.lineTo(c - x, y)
  }
  s.lineTo(0, WALL_H)
  s.closePath()
  s.holes.push(archHole(c - 1.95, 10.75, 11.75, 0.9))
  s.holes.push(archHole(c + 1.95, 10.75, 11.75, 0.9))
  s.holes.push(archHole(c, 12.9, 13.95, 0.9))
  const win = new Path()
  win.absarc(c, 7.3, 0.72, 0, Math.PI * 2, false)
  s.holes.push(win)
  return s
}

/** The church: its front, nave, pilasters, door, bells and cross, and the bell tower beside it. */
export function church(p: ArenaParts): void {
  const front = new ExtrudeGeometry(frontShape(), {
    depth: 1.1,
    bevelEnabled: false,
    curveSegments: 12,
  })
  front.applyMatrix4(wallFrame(V(-HALF, 0, FRONT_Z), V(0, 0, -1)))
  p.m.add('stone', front, LIMESTONE)
  const st = p.m.cell('stone')
  // the nave behind it, and its buttresses
  st.box(0, WALL_H / 2 - 0.3, FRONT_Z + 1.1 + 13, HALF * 2, WALL_H - 0.6, 26, LIMESTONE, {
    skip: ['bottom', 'nz'],
  })
  for (const sx of [-1, 1]) {
    for (const z of [FRONT_Z + 6, FRONT_Z + 13, FRONT_Z + 20]) {
      st.box(sx * (HALF + 0.5), 3.2, z, 1, 6.4, 1.6, LIMESTONE, { skip: ['bottom'] })
    }
  }
  // the front's carving: a plinth, pilasters flanking the door with niches, the cornice
  st.box(0, 0.3, FRONT_Z - 0.15, HALF * 2 + 0.3, 0.6, 0.3, 0xe0_d0_ba, { skip: ['bottom'] })
  for (const sx of [-1, 1]) {
    for (const x of [2.3, 4.6]) {
      st.box(sx * x, 4.4, FRONT_Z - 0.12, 0.6, 8.2, 0.26, LIMESTONE, { skip: ['bottom'] })
      st.box(sx * x, 0.5, FRONT_Z - 0.2, 0.8, 1.0, 0.4, 0xe0_d0_ba, { skip: ['bottom'] })
    }
    // a niche between each pair, a dark recess with a shell head
    st.box(sx * 3.45, 4.6, FRONT_Z - 0.04, 0.8, 1.6, 0.1, 0x8a_7a_6a)
    st.box(sx * 3.45, 5.55, FRONT_Z - 0.14, 1.1, 0.24, 0.28, LIMESTONE)
    st.box(sx * 3.45, 3.72, FRONT_Z - 0.16, 1.0, 0.16, 0.32, LIMESTONE)
  }
  st.box(0, WALL_H - 0.15, FRONT_Z - 0.18, HALF * 2 + 0.4, 0.3, 0.36, 0xe8_dc_c8)
  st.box(0, 8.45, FRONT_Z - 0.14, 6.2, 0.2, 0.28, 0xe8_dc_c8)
  // the door's archivolt and keystone, the doors set back in the opening
  const ring = new ExtrudeGeometry(arcRing(1.4, 1.85), {
    depth: 0.24,
    bevelEnabled: false,
    curveSegments: 12,
  })
  ring.applyMatrix4(wallFrame(V(0, 3.2, FRONT_Z - 0.24), V(0, 0, -1)))
  p.m.add('stone', ring, 0xe8_dc_c8)
  st.box(0, 3.2 + 1.75, FRONT_Z - 0.3, 0.5, 0.6, 0.3, 0xe8_dc_c8)
  for (const sx of [-1, 1]) {
    st.box(sx * 1.62, 1.6, FRONT_Z - 0.12, 0.46, 3.2, 0.24, 0xe8_dc_c8, { skip: ['bottom'] })
  }
  const t = p.trim
  t.box(0, 2.3, FRONT_Z + 0.75, 2.8, 4.6, 0.12, 0x4a_30_1e)
  for (const x of [-0.7, 0.7]) {
    for (const y of [1.0, 2.4, 3.6]) {
      t.box(x, y, FRONT_Z + 0.68, 1.1, 0.9, 0.04, 0x3a_24_16)
    }
  }
  t.box(0, 2.3, FRONT_Z + 0.66, 0.06, 4.4, 0.06, 0x2a_1a_10)
  // the choir window: dark glass, lit from within after dusk
  p.glass.box(0, 7.3, FRONT_Z + 0.55, 1.5, 1.5, 0.04, 0xff_ff_ff)
  // its iron grille: a cross of bars and a ring
  t.box(0, 7.3, FRONT_Z + 0.4, 1.5, 0.07, 0.07, IRON)
  t.box(0, 7.3, FRONT_Z + 0.4, 0.07, 1.5, 0.07, IRON)
  for (const d of [-0.45, 0.45]) {
    t.box(d, 7.3, FRONT_Z + 0.42, 0.05, 1.2, 0.05, IRON)
    t.box(0, 7.3 + d, FRONT_Z + 0.42, 1.2, 0.05, 0.05, IRON)
  }
  for (const [x, y] of [
    [-1.95, 10.75],
    [1.95, 10.75],
    [0, 12.9],
  ] as const) {
    // a bell in each arch, hung from its beam
    t.box(x, y + 1.15, FRONT_Z + 0.55, 0.9, 0.12, 0.14, BEAM)
    cyl(p.m.cell('tin'), x, y + 0.42, FRONT_Z + 0.55, 0.36, 0.16, 0.62, 12, 0x6a_4a_26)
    p.m.cell('tin').box(x, y + 1.0, FRONT_Z + 0.55, 0.12, 0.18, 0.12, IRON)
  }
  // the cross on the crown
  t.box(0, 16.6, FRONT_Z + 0.55, 0.16, 1.6, 0.16, IRON)
  t.box(0, 16.9, FRONT_Z + 0.55, 0.8, 0.14, 0.14, IRON)
  // the bell tower at the church's left shoulder (screen left): a square shaft, an open belfry,
  // a dome and lantern
  const tx = HALF + 2.1
  const tz = FRONT_Z + 1.9
  st.box(tx, 6, tz, 3.8, 12, 3.8, LIMESTONE, { skip: ['bottom'] })
  st.box(tx, 12.1, tz, 4.1, 0.25, 4.1, 0xe8_dc_c8)
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      st.box(tx + dx * 1.55, 13.7, tz + dz * 1.55, 0.7, 3.0, 0.7, LIMESTONE)
    }
  }
  st.box(tx, 15.35, tz, 4.0, 0.3, 4.0, 0xe8_dc_c8)
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * (Math.PI / 2)
    const a1 = ((i + 1) / 6) * (Math.PI / 2)
    cyl(
      st,
      tx,
      15.5 + Math.sin(a0) * 1.6,
      tz,
      Math.cos(a0) * 1.75,
      Math.cos(a1) * 1.75,
      (Math.sin(a1) - Math.sin(a0)) * 1.6,
      14,
      PLASTER,
      false,
    )
  }
  st.box(tx, 17.4, tz, 0.5, 0.6, 0.5, LIMESTONE)
  t.box(tx, 18.2, tz, 0.12, 1.1, 0.12, IRON)
  t.box(tx, 18.4, tz, 0.55, 0.1, 0.1, IRON)
  cyl(p.m.cell('tin'), tx, 13.1, tz, 0.5, 0.22, 0.8, 12, 0x6a_4a_26)
  t.box(tx, 14.05, tz, 3.2, 0.14, 0.16, BEAM)
}

/** A half-annulus outline (an archivolt) centred on the origin. */
function arcRing(r0: number, r1: number): Shape {
  const s = new Shape()
  s.moveTo(r1, 0)
  s.absarc(0, 0, r1, 0, Math.PI, false)
  s.lineTo(-r0, 0)
  s.absarc(0, 0, r0, Math.PI, 0, true)
  s.closePath()
  return s
}
