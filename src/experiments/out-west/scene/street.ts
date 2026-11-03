// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * The street's layout and its fronts: the street dimensions, every building and sign, and the kit
 * pieces that dress a false front (door, windows, shutters, balcony rail) and the boardwalks.
 */
import { Matrix4, Vector3 } from 'three'
import type { GeoBuilder } from './geo.ts'
import { type PropDef, placeMatrix, propDef, propsLibrary } from './props.ts'
import type { SignSpec } from './textures.ts'

/** Street layout (metres). The street runs along Z; the duel is centred on the origin. */
export interface Placed {
  def: PropDef
  at: Matrix4
}

export const STREET = {
  half: 9,
  boardwalk: 2.4,
  churchZ: 64,
  posterPos: new Vector3(-8.2, 0, -2.5),
  /** The rifleman stands on the saloon's porch roof. */
  saloonRoof: new Vector3(10.4, 3.18, 6.2),
} as const

/** Top of the boardwalks: everything on a porch stands at this height, not on the dirt. */
export const DECK = 0.34
/** Underside of the porch roofs (awnings), 3.1 m up, 0.12 thick. */
export const AWNING = 3.04

/**
 * Hanging lanterns (and their lights) under the porch roofs nearest the duel: x, z. Each sits
 * under a building's awning, never in the gaps between buildings.
 */
export const LANTERNS: readonly (readonly [number, number])[] = [
  [-9.4, -10],
  [9.4, -4],
  [-9.4, 2],
  [9.4, 10.5],
  [-9.4, 13],
  [9.4, 20],
]

export interface BuildingSpec {
  side: -1 | 1
  z: number
  w: number
  h: number
  front: number
  depth: number
  color: number
  sign: number
  kind?: 'saloon' | 'undertaker' | 'bank' | 'stable' | 'plain'
}

export const SIGNS: SignSpec[] = [
  { text: 'SALOON', bg: '#6a1f14', fg: '#f3e2b8' },
  { text: 'GENERAL STORE', bg: '#2c3a2a', fg: '#efe0b0' },
  { text: 'SHERIFF', bg: '#1d2430', fg: '#e6c25a' },
  { text: 'UNDERTAKER', bg: '#141414', fg: '#d9d0bf' },
  { text: 'BANK', bg: '#3a2e1c', fg: '#e8cf7a' },
  { text: 'LIVERY STABLE', bg: '#5a3a22', fg: '#f0dcb0' },
  { text: 'HOTEL', bg: '#2a2236', fg: '#ead9b8' },
  { text: 'BARBER', bg: '#e9e2d0', fg: '#7a1a12' },
  { text: 'ASSAY OFFICE', bg: '#2b2b2b', fg: '#d8c9a4' },
  { text: 'POST OFFICE', bg: '#2e3b48', fg: '#efe6cf' },
  { text: 'GUNSMITH', bg: '#3b1c14', fg: '#f0d9a0' },
  { text: 'TELEGRAPH', bg: '#203028', fg: '#e8dcc0' },
]

export const BUILDINGS: BuildingSpec[] = [
  // right side (+x), heading toward the church
  {
    side: 1,
    z: -46,
    w: 13,
    h: 5.2,
    front: 7.5,
    depth: 12,
    color: 0x8a_6a_4a,
    sign: 5,
    kind: 'stable',
  },
  { side: 1, z: -33, w: 9, h: 5.0, front: 7.4, depth: 10, color: 0xb8_a6_90, sign: 10 },
  {
    side: 1,
    z: -22,
    w: 10,
    h: 5.5,
    front: 8.2,
    depth: 10,
    color: 0x9a_8a_72,
    sign: 4,
    kind: 'bank',
  },
  { side: 1, z: -10.5, w: 11, h: 5.2, front: 7.6, depth: 10, color: 0x7a_8a_7a, sign: 1 },
  {
    side: 1,
    z: 2,
    w: 12,
    h: 6.2,
    front: 8.4,
    depth: 12,
    color: 0x8a_4a_34,
    sign: 0,
    kind: 'saloon',
  },
  { side: 1, z: 15, w: 11, h: 7.2, front: 9.0, depth: 11, color: 0x9a_8a_a0, sign: 6 },
  { side: 1, z: 27, w: 8, h: 4.6, front: 6.6, depth: 9, color: 0xc0_b4_9a, sign: 7 },
  { side: 1, z: 37, w: 10, h: 5.0, front: 7.0, depth: 10, color: 0x7a_6a_5a, sign: 11 },
  // left side (-x)
  { side: -1, z: -44, w: 12, h: 5.0, front: 7.2, depth: 10, color: 0x9a_7a_5a, sign: 8 },
  { side: -1, z: -31, w: 10, h: 5.4, front: 7.8, depth: 10, color: 0x6a_7a_8a, sign: 9 },
  { side: -1, z: -19.5, w: 10, h: 5.2, front: 7.6, depth: 10, color: 0x5a_60_70, sign: 2 },
  {
    side: -1,
    z: -6.5,
    w: 10,
    h: 5.0,
    front: 7.4,
    depth: 10,
    color: 0x4a_44_3e,
    sign: 3,
    kind: 'undertaker',
  },
  { side: -1, z: 5.5, w: 11, h: 5.6, front: 8.0, depth: 11, color: 0xa0_8a_6a, sign: 1 },
  { side: -1, z: 18, w: 11, h: 6.6, front: 8.6, depth: 11, color: 0x8a_5a_44, sign: 6 },
  { side: -1, z: 30, w: 10, h: 4.8, front: 6.8, depth: 10, color: 0xb0_a0_80, sign: 10 },
]

/**
 * The floor height at (x, z): the boardwalk's top in front of a building, else the street (0).
 * Props are placed with this so nothing stands on air in the gaps between buildings or sinks
 * into a deck.
 */
export function deckAt(x: number, z: number): number {
  const ax = Math.abs(x)
  if (ax < STREET.half || ax > STREET.half + STREET.boardwalk) {
    return 0
  }
  const side = x > 0 ? 1 : -1
  const on = BUILDINGS.some((b) => b.side === side && Math.abs(z - b.z) <= b.w / 2)
  return on ? DECK : 0
}

/**
 * A building's street face: the kit's panelled door (double doors for the livery), framed
 * glazed windows either side, and on two-storey fronts upper windows with open shutters and a
 * balcony rail along the porch roof. Kit pieces face +Z with their base at the wall's foot.
 */
export function facade(
  b: BuildingSpec,
  fx: number,
  out: { glass: GeoBuilder; trim: GeoBuilder; kit: Placed[] },
): void {
  const s = b.side
  const lib = propsLibrary()
  const piece = (name: string) => (lib ? propDef(lib, name, 1, 'y', true) : null)
  const door = piece(b.kind === 'stable' ? 'k_door_braced' : 'k_door')
  const frame = piece('k_doorframe')
  const win = piece('k_window_wide')
  const thin = piece('k_window_thin')
  const shut = piece('k_shutters_thin')
  const rail = piece('k_balcony')
  if (!(door && frame && win && thin && shut && rail)) {
    plainFacade(b, fx, out)
    return
  }
  // kit +Z turned to face the street (-s along X), its back on the false front
  const ry = -s * (Math.PI / 2)
  const face = fx - s * 0.25
  const put = (def: PropDef, z: number, y = 0, depth = 0.03, sx = 1) =>
    out.kit.push({
      def,
      at: placeMatrix(face - s * depth, y, z, ry).scale(new Vector3(sx, 1, 1)),
    })
  // the doorway and the ground-floor windows stand on the boardwalk, not on the dirt under it
  if (b.kind === 'stable') {
    // two leaves narrowed to fill the widened frame's opening, not overlap its jambs
    put(door, b.z - 0.44, DECK, 0.06, 0.78)
    put(door, b.z + 0.44, DECK, 0.06, 0.78)
    put(frame, b.z, DECK, 0.12, 1.5)
  } else {
    // the saloon's doorway holds its batwings (world.ts), not a closed door behind them
    if (b.kind !== 'saloon') {
      put(door, b.z, DECK, 0.06)
    }
    put(frame, b.z, DECK, 0.12)
  }
  for (const dz of [-1, 1]) {
    put(win, b.z + dz * (b.w / 2 - 1.8), DECK, 0.02)
  }
  if (b.h > 5.4) {
    for (const dz of [-1, 1]) {
      const wz = b.z + dz * (b.w / 4)
      put(thin, wz, b.h - 2.9, 0)
      put(shut, wz, b.h - 2.9, -0.12)
    }
    // a rail along the porch roof, two-metre sections
    const aw = 3.1
    const n = Math.max(1, Math.floor((b.w - 0.4) / 2))
    for (let i = 0; i < n; i++) {
      const z = b.z - ((n - 1) * 2) / 2 + i * 2
      out.kit.push({
        def: rail,
        at: placeMatrix(s * (STREET.half + 0.25), aw + 0.06, z, ry + Math.PI).multiply(
          new Matrix4().makeTranslation(0, 0, -0.95),
        ),
      })
    }
  }
}

/** The old flat-box facade (props library missing). */
function plainFacade(
  b: BuildingSpec,
  fx: number,
  out: { glass: GeoBuilder; trim: GeoBuilder },
): void {
  const { glass, trim } = out
  const s = b.side
  const upper = b.h > 5.4 ? 2 : 0
  for (let i = 0; i < upper; i++) {
    const wz = b.z + (i === 0 ? -1 : 1) * (b.w / 4)
    glass.box(fx - s * 0.28, b.h - 1.2, wz, 0.06, 1.3, 0.9, 0xff_ff_ff)
    trim.box(fx - s * 0.3, b.h - 1.2, wz, 0.08, 1.5, 1.1, 0xd8_cc_b0)
  }
  const doorW = b.kind === 'stable' ? 3.2 : 1.4
  glass.box(fx - s * 0.27, 1.25, b.z, 0.06, 2.5, doorW, 0xff_ff_ff)
  trim.box(fx - s * 0.29, 1.3, b.z, 0.08, 2.7, doorW + 0.3, 0x2a_1d_14)
  for (const dz of [-1, 1]) {
    const wz = b.z + dz * (b.w / 2 - 1.8)
    glass.box(fx - s * 0.28, 1.7, wz, 0.06, 1.6, 1.8, 0xff_ff_ff)
    trim.box(fx - s * 0.3, 1.7, wz, 0.08, 1.85, 2.05, 0xd8_cc_b0)
    trim.box(fx - s * 0.32, 0.86, wz, 0.25, 0.1, 2.2, 0x3a_2a_1e)
  }
}

/** Benches, buckets, sacks and a chest or two along the boardwalks, by the doors. */
export function dressBoardwalks(kit: Placed[]): void {
  const lib = propsLibrary()
  if (!lib) {
    return
  }
  const def = (n: string) => propDef(lib, n, 1, 'y', true)
  const bench = def('k_bench')
  const bucket = def('k_bucket')
  const sack = def('k_sack')
  const chest = def('k_chest')
  const rack = def('k_barrel_rack')
  const H = STREET.half
  const deck = DECK
  let i = 0
  for (const b of BUILDINGS) {
    const s = b.side
    const ry = -s * (Math.PI / 2)
    const fx = s * (H + STREET.boardwalk) - s * 0.6
    i++
    if (bench && b.kind !== 'stable' && i % 2 === 0) {
      kit.push({
        def: bench,
        at: placeMatrix(fx, deck, b.z + (b.w / 2 - 1.8) * (i % 4 === 0 ? 1 : -1), ry),
      })
    }
    if (bucket && i % 3 === 0) {
      kit.push({ def: bucket, at: placeMatrix(fx + s * 0.2, deck, b.z + 1.3, i) })
    }
    if (sack && (b.kind === 'stable' || i % 4 === 1)) {
      kit.push({ def: sack, at: placeMatrix(fx, deck, b.z - b.w / 2 + 0.8, i * 1.7) })
      kit.push({
        def: sack,
        at: placeMatrix(fx - s * 0.1, deck, b.z - b.w / 2 + 1.5, i * 2.3, 0.9),
      })
    }
    if (chest && b.kind === 'bank') {
      kit.push({ def: chest, at: placeMatrix(fx, deck, b.z + 2.6, ry) })
    }
    if (rack && b.kind === 'saloon') {
      kit.push({ def: rack, at: placeMatrix(fx, deck, b.z - 3.2, ry) })
    }
  }
}
