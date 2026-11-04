// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noMagicNumbers: an arena is a table of measurements, in metres
/**
 * Act IV: the bank square at night (outlaws 14–15).
 *
 * The money end of town: two-storey brick blocks with cast-iron shopfronts, galleries on iron
 * columns, gas lamps on the kerbs, and across the head of the lane the First National Bank, a
 * sandstone ground floor of tall arches under a brick storey, a bracketed cornice and a pediment,
 * every window lit. The blocks keep the main street's frontage (sidewalks at the boardwalks' height,
 * the same doors and benches), so the townsfolk stand where they always do, on brick instead of
 * boards; the hero shot at the call is the lit bank behind the outlaw, the lamps running up to it.
 */
import { ExtrudeGeometry, Path, Shape, Vector3, Vector4 } from 'three'
import { type Face, quoins, sashWindow } from '../courthouse.ts'
import { wallFrame } from '../masonry.ts'
import { DECK, STREET } from '../street.ts'
import type { LifeLayout } from '../townlife.ts'
import { ArenaParts, cyl, hitchRail, placeAt, YAW } from './build.ts'
import type { Arena, ArenaCtx } from './types.ts'

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

const H = STREET.half
/** The fronts' plane (the street's false-front line) and the sidewalk between. */
const FRONT = H + STREET.boardwalk
/** The gallery deck's top: where the street's porch-roof folk stand. */
const GALLERY = 3.16
/** The bank's front (it faces down the lane) and its half width. */
const BANK_Z = 44
const BANK_HALF = 8.2

const STONE = 0xf0_e4_d2
const IRON = 0x2a_2c_2e
const CORNICE = 0x4a_3e_34

interface Block {
  side: -1 | 1
  z0: number
  z1: number
  h: number
  brick: number
  sign: string
  bg: string
  fg: string
  /** Doors along the front (z), shop windows fill between. */
  doors: number[]
  /** A two-storey gallery across the front. */
  gallery?: boolean
}

/** The blocks either side, their doors where the street's townsfolk expect them. */
const BLOCKS: readonly Block[] = [
  {
    side: 1,
    z0: -40,
    z1: -24,
    h: 8.4,
    brick: 0xd8_b0_a0,
    sign: 'HARDWARE',
    bg: '#1e2622',
    fg: '#e8d8a8',
    doors: [-32],
  },
  {
    side: 1,
    z0: -23,
    z1: -9,
    h: 9.4,
    brick: 0xe0_c4_b4,
    sign: 'DRY GOODS',
    bg: '#2a1e18',
    fg: '#ecdcb4',
    doors: [-16],
  },
  {
    side: 1,
    z0: -8,
    z1: 8,
    h: 10,
    brick: 0xd0_a0_8e,
    sign: 'GRAND HOTEL',
    bg: '#2a2236',
    fg: '#ead9b8',
    doors: [2],
  },
  {
    side: 1,
    z0: 9,
    z1: 20,
    h: 8.6,
    brick: 0xe4_c8_b8,
    sign: 'ASSAYER',
    bg: '#2b2b2b',
    fg: '#d8c9a4',
    doors: [15],
    gallery: true,
  },
  {
    side: 1,
    z0: 21,
    z1: 34,
    h: 9.2,
    brick: 0xd4_ac_96,
    sign: 'DRUGS',
    bg: '#203028',
    fg: '#e8dcc0',
    doors: [27],
  },
  {
    side: -1,
    z0: -40,
    z1: -26,
    h: 8.6,
    brick: 0xd8_b8_a6,
    sign: 'LAND OFFICE',
    bg: '#2e3b48',
    fg: '#efe6cf',
    doors: [-33],
  },
  {
    side: -1,
    z0: -25,
    z1: -10,
    h: 9.6,
    brick: 0xcc_9c_8a,
    sign: 'TELEGRAPH',
    bg: '#203028',
    fg: '#e8dcc0',
    doors: [-17],
  },
  {
    side: -1,
    z0: -9,
    z1: 4,
    h: 8.8,
    brick: 0xe0_c0_ae,
    sign: 'MERCANTILE',
    bg: '#3a2e1c',
    fg: '#e8cf7a',
    doors: [-3, 2.5],
  },
  {
    side: -1,
    z0: 5,
    z1: 22,
    h: 10.2,
    brick: 0xd2_a4_90,
    sign: 'BILLIARDS',
    bg: '#6a1f14',
    fg: '#f3e2b8',
    doors: [5.5, 18],
    gallery: true,
  },
  {
    side: -1,
    z0: 23,
    z1: 36,
    h: 9,
    brick: 0xdc_bc_aa,
    sign: 'THE GAZETTE',
    bg: '#141414',
    fg: '#d9d0bf',
    doors: [30],
  },
]

/** One brick block: shopfront, upper sash windows, cornice, sign, gallery and sidewalk. */
function block(p: ArenaParts, b: Block): void {
  const s = b.side
  const br = p.m.cell('brick')
  const st = p.m.cell('stone')
  const len = b.z1 - b.z0
  const zc = (b.z0 + b.z1) / 2
  const depth = 12
  const xc = s * (FRONT + depth / 2)
  // the brick mass above the shopfront, the shopfront's iron frame below
  br.box(xc, (4.1 + b.h) / 2, zc, depth, b.h - 4.1, len - 0.05, b.brick, { skip: ['bottom'] })
  br.box(s * (FRONT + depth / 2 + 0.3), 2.05, zc, depth - 0.6, 4.1, len - 0.05, b.brick, {
    skip: ['bottom', 'top'],
  })
  const face: Face = { nx: -s, nz: 0, d: s * FRONT }
  // quoins on the corners, a stone band at the floor line, the bracketed cornice
  quoins(st, s * FRONT, b.z0 + 0.02, -s, -1, 4.1, b.h)
  quoins(st, s * FRONT, b.z1 - 0.02, -s, 1, 4.1, b.h)
  st.box(s * (FRONT - 0.1), 4.18, zc, 0.3, 0.2, len, STONE)
  p.walls.box(s * (FRONT - 0.3), b.h - 0.2, zc, 0.6, 0.4, len + 0.2, CORNICE)
  for (let z = b.z0 + 0.4; z < b.z1; z += 0.9) {
    p.walls.box(s * (FRONT - 0.18), b.h - 0.55, z, 0.36, 0.3, 0.14, CORNICE)
  }
  // the upper storey's sash windows
  const n = Math.max(2, Math.floor(len / 2.6))
  for (let i = 0; i < n; i++) {
    const z = b.z0 + (len / n) * (i + 0.5)
    sashWindow(p, face, z, 5.3)
  }
  shopfront(p, b)
  // the brick sidewalk, a stone kerb
  st.box(
    s * (H + STREET.boardwalk / 2),
    DECK / 2,
    zc,
    STREET.boardwalk,
    DECK,
    len + 1,
    0xc8_8a_70,
    {
      skip: ['bottom'],
    },
  )
  st.box(s * (H + 0.1), DECK / 2 + 0.01, zc, 0.2, DECK + 0.02, len + 1, 0xd8_d0_c4, {
    skip: ['bottom'],
  })
  if (b.gallery) {
    gallery(p, b)
  }
}

/** A block's ground floor: iron columns, plate glass to the doors, the transom and the sign. */
function shopfront(p: ArenaParts, b: Block): void {
  const s = b.side
  const t = p.trim
  const len = b.z1 - b.z0
  const zc = (b.z0 + b.z1) / 2
  // the shopfront: iron columns, plate glass to the doors, a transom band and the sign over it
  for (let z = b.z0 + 0.25; z <= b.z1 - 0.2; z += len / Math.max(2, Math.round(len / 3))) {
    if (b.doors.some((dz) => Math.abs(dz - z) < 1.0)) {
      continue
    }
    t.box(s * (FRONT - 0.12), (DECK + 4.0) / 2, z, 0.24, 4.0 - DECK, 0.24, IRON)
  }
  t.box(s * (FRONT - 0.12), 4.0, zc, 0.26, 0.2, len, IRON)
  const doorW = 1.2
  const panes: [number, number][] = []
  let from = b.z0 + 0.4
  for (const dz of [...b.doors].sort((u, v) => u - v)) {
    panes.push([from, dz - doorW / 2 - 0.1])
    from = dz + doorW / 2 + 0.1
  }
  panes.push([from, b.z1 - 0.4])
  for (const [z0, z1] of panes) {
    if (z1 - z0 > 0.5) {
      // plate glass in lights a metre wide, a transom row over them, a panelled stall board below
      const gx = s * (FRONT - 0.03)
      t.box(s * (FRONT - 0.035), DECK + 0.36, (z0 + z1) / 2, 0.05, 0.68, z1 - z0, 0x3a_2a_22)
      p.glass.box(gx, DECK + 0.7 + 0.95, (z0 + z1) / 2, 0.04, 1.9, z1 - z0, 0xff_ff_ff)
      p.glass.box(gx, DECK + 3.05, (z0 + z1) / 2, 0.04, 0.42, z1 - z0, 0xff_ff_ff)
      t.box(s * (FRONT - 0.07), DECK + 2.72, (z0 + z1) / 2, 0.08, 0.24, z1 - z0, IRON)
      const lights = Math.max(1, Math.round((z1 - z0) / 1.0))
      for (let k = 1; k < lights; k++) {
        const z = z0 + ((z1 - z0) * k) / lights
        t.box(s * (FRONT - 0.07), DECK + 1.9, z, 0.07, 2.5, 0.06, IRON)
      }
    }
  }
  for (const dz of b.doors) {
    p.put('k_door', placeAt(s * (FRONT - 0.06), DECK, dz, s > 0 ? YAW['-x'] : YAW['+x']))
    p.put('k_doorframe', placeAt(s * (FRONT - 0.12), DECK, dz, s > 0 ? YAW['-x'] : YAW['+x']))
  }
  p.board(
    { text: b.sign, bg: b.bg, fg: b.fg },
    s * (FRONT - 0.2),
    3.55,
    zc,
    s > 0 ? '-x' : '+x',
    Math.min(len - 1.6, 8),
    0.6,
  )
}

/** A gallery on iron columns, its deck where the street's porch roof was, an iron rail. */
function gallery(p: ArenaParts, b: Block): void {
  const s = b.side
  const t = p.trim
  const len = b.z1 - b.z0
  const zc = (b.z0 + b.z1) / 2
  // a gallery on iron columns, its deck where the street's porch roof was, an iron rail
  const gx = s * (H + 0.4)
  t.box(
    s * (H + 0.4 + (FRONT - H - 0.4) / 2),
    GALLERY - 0.06,
    zc,
    FRONT - H - 0.4,
    0.12,
    len,
    0x5a_46_34,
    {
      rotUV: true,
    },
  )
  for (let z = b.z0 + 0.3; z <= b.z1 - 0.2; z += (len - 0.5) / Math.round(len / 3)) {
    cyl(t, gx, DECK, z, 0.08, 0.08, GALLERY - 0.12 - DECK, 8, IRON, false)
  }
  t.box(gx, GALLERY + 1.0, zc, 0.08, 0.08, len, IRON)
  t.box(gx, GALLERY + 0.12, zc, 0.06, 0.06, len, IRON)
  for (let z = b.z0 + 0.2; z < b.z1; z += 0.18) {
    t.box(gx, GALLERY + 0.56, z, 0.03, 0.88, 0.03, IRON)
  }
  // the gallery's upper doors onto it
  for (const dz of b.doors) {
    p.put('k_door', placeAt(s * (FRONT - 0.06), GALLERY, dz, s > 0 ? YAW['-x'] : YAW['+x']))
    p.put('k_doorframe', placeAt(s * (FRONT - 0.12), GALLERY, dz, s > 0 ? YAW['-x'] : YAW['+x']))
  }
}

/** The bank's ground floor front in local units: rusticated stone with three tall arches. */
function bankFront(): Shape {
  const s = new Shape()
  const W = BANK_HALF * 2
  s.moveTo(0, 0)
  // the door's arch notched up from the steps' top
  const c = BANK_HALF
  s.lineTo(c - 1.1, 0)
  s.lineTo(c - 1.1, 2.6)
  s.absarc(c, 2.6, 1.1, Math.PI, 0, true)
  s.lineTo(c + 1.1, 0)
  s.lineTo(W, 0)
  s.lineTo(W, 4.6)
  s.lineTo(0, 4.6)
  s.closePath()
  for (const x of [c - 4.4, c - 2.6, c + 2.6, c + 4.4]) {
    const h = new Path()
    h.moveTo(x - 0.6, 0.9)
    h.lineTo(x + 0.6, 0.9)
    h.lineTo(x + 0.6, 3.1)
    h.absarc(x, 3.1, 0.6, 0, Math.PI, false)
    h.closePath()
    s.holes.push(h)
  }
  return s
}

/** The First National Bank across the head of the lane. */
function bank(p: ArenaParts): void {
  const st = p.m.cell('stone')
  const br = p.m.cell('brick')
  const t = p.trim
  const z = BANK_Z
  const depth = 14
  const plinth = 0.9
  // steps up to a stone terrace
  for (let k = 0; k < 3; k++) {
    st.box(0, (k + 1) * 0.3 - 0.15, z - 2.2 + k * 0.45, 6.2 - k * 0.4, 0.3, 0.45, STONE, {
      skip: ['bottom'],
    })
  }
  st.box(0, plinth / 2, z - 0.4, BANK_HALF * 2 + 0.3, plinth, 1.2, STONE, { skip: ['bottom'] })
  const front = new ExtrudeGeometry(bankFront(), {
    depth: 0.7,
    bevelEnabled: false,
    curveSegments: 12,
  })
  front.applyMatrix4(wallFrame(V(-BANK_HALF, plinth, z), V(0, 0, -1)))
  p.m.add('stone', front, STONE)
  // rustication: deep joints across the stone storey
  for (let y = plinth + 0.55; y < plinth + 4.6; y += 0.55) {
    st.box(0, y, z - 0.02, BANK_HALF * 2, 0.05, 0.04, 0xb8_ac_9c)
  }
  // the body behind, brick above, a stone band, the upper windows
  br.box(
    0,
    (plinth + 9.4) / 2,
    z + depth / 2 + 0.7,
    BANK_HALF * 2,
    9.4 - plinth,
    depth,
    0xc8_8c_78,
    {
      skip: ['bottom', 'nz'],
    },
  )
  br.box(
    0,
    plinth + 4.6 + (9.4 - plinth - 4.6) / 2,
    z + 0.35,
    BANK_HALF * 2,
    9.4 - plinth - 4.6,
    0.7,
    0xc8_8c_78,
    {
      skip: ['bottom', 'top'],
    },
  )
  st.box(0, plinth + 5.0, z - 0.1, BANK_HALF * 2 + 0.3, 0.84, 0.6, STONE)
  const face: Face = { nx: 0, nz: -1, d: z }
  for (const x of [-6, -3, 0, 3, 6]) {
    sashWindow(p, face, x, plinth + 5.75)
  }
  quoins(st, -BANK_HALF, z, -1, -1, plinth + 4.8, 9.4)
  quoins(st, BANK_HALF, z, 1, -1, plinth + 4.8, 9.4)
  // the sign frieze between the floors
  p.board(
    { text: 'FIRST NATIONAL BANK', bg: '#141210', fg: '#e8c870' },
    0,
    plinth + 5.0,
    z - 0.405,
    '-z',
    8.6,
    0.62,
  )
  // lit glass in the arches, iron grilles over the side windows, the doors set back
  for (const x of [-4.4, -2.6, 2.6, 4.4]) {
    p.glass.box(x, plinth + 2.3, z + 0.5, 1.2, 2.8, 0.04, 0xff_ff_ff)
    for (const dx of [-0.36, -0.12, 0.12, 0.36]) {
      t.box(x + dx, plinth + 2.3, z + 0.12, 0.03, 2.8, 0.03, IRON)
    }
  }
  p.glass.box(0, plinth + 3.0, z + 0.55, 2.2, 1.0, 0.04, 0xff_ff_ff)
  t.box(0, plinth + 1.25, z + 0.6, 2.2, 2.5, 0.1, 0x3a_22_14)
  t.box(0, plinth + 1.25, z + 0.54, 0.05, 2.4, 0.05, 0x1a_10_0a)
  // the portico: two columns, an entablature and a pediment over the door
  for (const sx of [-1, 1]) {
    cyl(st, sx * 1.55, plinth, z - 0.7, 0.24, 0.2, 3.8, 12, STONE)
    st.box(sx * 1.55, plinth + 0.12, z - 0.7, 0.62, 0.24, 0.62, STONE)
    st.box(sx * 1.55, plinth + 3.9, z - 0.7, 0.56, 0.2, 0.56, STONE)
  }
  st.box(0, plinth + 4.2, z - 0.55, 4.0, 0.4, 1.0, STONE)
  st.tri(
    V(-2.1, plinth + 4.4, z - 1.05),
    V(2.1, plinth + 4.4, z - 1.05),
    V(0, plinth + 5.1, z - 1.05),
    STONE,
  )
  // the cornice on brackets, the parapet and its pediment with the year, a flagpole
  p.walls.box(0, 9.55, z - 0.2, BANK_HALF * 2 + 0.6, 0.35, 1.2, CORNICE)
  for (let x = -BANK_HALF; x <= BANK_HALF; x += 0.8) {
    p.walls.box(x, 9.2, z - 0.15, 0.14, 0.35, 0.4, CORNICE)
  }
  br.box(0, 10.3, z + 0.2, BANK_HALF * 2, 1.1, 0.4, 0xc8_8c_78, { skip: ['bottom'] })
  st.box(0, 10.9, z + 0.2, BANK_HALF * 2 + 0.2, 0.14, 0.56, STONE)
  st.tri(V(-3.2, 10.95, z - 0.08), V(3.2, 10.95, z - 0.08), V(0, 12.6, z - 0.08), STONE)
  st.tri(V(3.2, 10.95, z + 0.48), V(-3.2, 10.95, z + 0.48), V(0, 12.6, z + 0.48), STONE)
  p.board({ text: '1879', bg: '#e8dcc8', fg: '#3a2a1c' }, 0, 11.55, z - 0.1, '-z', 1.3, 0.42)
  cyl(t, 0, 12.6, z + 0.2, 0.05, 0.04, 4.2, 6, 0xd0_c8_b8, false)
  t.box(0.62, 15.9, z + 0.2, 1.2, 0.7, 0.02, 0x8a_1e_18)
  // lamps either side of the steps
  for (const sx of [-1, 1]) {
    cyl(t, sx * 3.4, 0, z - 2.4, 0.08, 0.06, 2.6, 8, IRON, false)
  }
}

/** Gas lamps on the kerbs, a horse trough, hitching rails, the strongbox wagon. */
function square(p: ArenaParts): [number, number, number][] {
  const lamps: [number, number, number][] = []
  for (const [x, z] of [
    [-8.6, -2],
    [8.6, 6],
    [-8.6, 13],
    [8.6, 20],
    [-8.6, 28],
    [8.6, 34.5],
  ] as const) {
    p.prop('postlantern', 3.3, 'y', placeAt(x, DECK, z, x > 0 ? -Math.PI / 2 : Math.PI / 2), true)
    lamps.push([x, DECK + 3.0, z])
  }
  // the bank's own lamps
  p.prop('lantern', 0.45, 'y', placeAt(-3.4, 2.6, BANK_Z - 2.4), false)
  p.prop('lantern', 0.45, 'y', placeAt(3.4, 2.6, BANK_Z - 2.4), false)
  hitchRail(p.trim, H - 0.6, 4.4, 'z')
  hitchRail(p.trim, -(H - 0.6), 16.2, 'z')
  hitchRail(p.trim, -(H - 0.6), 28, 'z', 3.8)
  // a trough at the kerb
  p.trim.box(8.3, 0.35, -14, 0.9, 0.7, 2.4, 0x5a_44_30)
  // the express wagon waiting at the bank, a strongbox on it
  p.prop('cart', 4.2, 'max', placeAt(5.6, 0, BANK_Z - 6, 0.15))
  // benches on the sidewalks where the street's folk sit
  for (const [x, z] of [
    [10.8, 11.3],
    [-10.8, 14.3],
    [-10.8, -2.8],
  ] as const) {
    p.put('k_bench', placeAt(x, DECK, z, x > 0 ? YAW['-x'] : YAW['+x']))
  }
  p.prop('barrel', 1.0, 'y', placeAt(10.2, DECK, -14.5, 0.3))
  p.prop('crate', 0.85, 'y', placeAt(-10.15, DECK, 10.4, 0.1))
  p.prop('crate', 0.85, 'y', placeAt(10.15, DECK, 23.8, -0.2))
  // and the poster post on its own kerb
  return lamps
}

/** Low buildings closing the corners either side of the bank. */
function corners(p: ArenaParts): void {
  for (const s of [-1, 1] as const) {
    const br = p.m.cell('brick')
    const x = s * 14.5
    br.box(x, 3.4, 42, 10, 6.8, 10, 0xc0_90_7c, { skip: ['bottom'] })
    p.walls.box(x, 6.9, 37, 10.2, 0.3, 0.5, CORNICE)
    const f: Face = { nx: 0, nz: -1, d: 37 }
    for (const dx of [-2.5, 2.5]) {
      sashWindow(p, f, x + dx, 4.4)
    }
    p.glass.box(x - s, 1.6, 36.97, 3.6, 2.0, 0.04, 0xff_ff_ff)
  }
}

function lifeLayout(): LifeLayout {
  const faceR = -Math.PI / 2
  const faceL = Math.PI / 2
  const seat = DECK + 0.42
  // the street's own spots: the blocks keep its frontage, doors and benches
  return {
    folk: [
      { x: 9.75, y: GALLERY, z: 14, yaw: faceR, habit: 'rail', door: null },
      { x: 9.43, y: DECK, z: 19.85, yaw: faceR - 0.35, habit: 'lean', door: [H + 2.05, 15] },
      { x: -10.4, y: DECK, z: 27.5, yaw: faceL - 0.3, habit: 'stand', door: [-(H + 2.05), 30] },
      { x: -9.75, y: GALLERY, z: 19.6, yaw: faceL, habit: 'rail', door: null },
      { x: 10.72, y: seat, z: 11.3, yaw: faceR, habit: 'whittle', door: [H + 2.05, 15] },
      { x: 10.85, y: DECK, z: 2.05, yaw: faceR - 0.4, habit: 'door', door: [H + 2.1, 2] },
      { x: -10.72, y: seat, z: 14.3, yaw: faceL, habit: 'sit', door: [-(H + 2.05), 18] },
      { x: -9.43, y: DECK, z: 7.55, yaw: faceL + 0.35, habit: 'lean', door: [-(H + 2.05), 5.5] },
      { x: -10.72, y: seat, z: -2.8, yaw: faceL, habit: 'sit', door: null },
    ],
    crows: { x: -(H - 0.6), y: 1.0, z: 28, along: 'z', face: Math.PI / 2 },
    horses: [
      { x: H - 0.6 - 1.25, y: 0, z: 4.4, yaw: Math.PI / 2 },
      { x: -(H - 0.6 - 1.25), y: 0, z: 16.2, yaw: -Math.PI / 2 },
    ],
    dog: { x: 10.05, y: DECK, z: 25.4, yaw: faceR },
    door: { x: FRONT - 0.4, y: DECK, z: 27 - 0.45, yaw: 0 },
    hens: null,
  }
}

export function build(ctx: ArenaCtx): Arena {
  const p = new ArenaParts(ctx, 'bank')
  for (const b of BLOCKS) {
    block(p, b)
  }
  bank(p)
  corners(p)
  const lamps = square(p)
  p.finish()
  const pools = [
    ...lamps.map(([x, , z]) => new Vector4(x * 0.95, z, 5, 1)),
    new Vector4(0, BANK_Z - 3, 5, -0.9),
    ...BLOCKS.filter((b) => Math.abs((b.z0 + b.z1) / 2) < 30).map(
      (b) => new Vector4(b.side * (H + 0.6), (b.z0 + b.z1) / 2, 3.6, -0.6),
    ),
  ]
  return {
    id: 'bank',
    root: p.root,
    lanterns: lamps,
    pools,
    bell: V(0, 9, BANK_Z + 4),
    life: lifeLayout(),
    ruts: 0.8,
    dispose: () => p.dispose(),
  }
}
