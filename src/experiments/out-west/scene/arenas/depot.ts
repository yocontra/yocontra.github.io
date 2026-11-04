// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noMagicNumbers: an arena is a table of measurements, in metres
/**
 * Act II: the rail depot (outlaws 7–10, afternoon into golden hour).
 *
 * The lane is the cinder yard between the station platform (+x) and the main line (-x). On the
 * platform side stands the depot, board-and-batten under a two-pitch roof whose canopy reaches out
 * over the platform on posts and knee braces, with the operator's bay, the train-order mast and the
 * station bell. On the track side a string of cars stands on the main: two boxcars, a flatcar of
 * crates and a red caboose, under a line of telegraph poles. Down the lane, the hero shot at the
 * call: the water tower over the track, the freight house and stock pens, a windmill against the
 * low sun, and the rails running off to the mesas.
 */
import { Vector3, Vector4 } from 'three'
import { DECK } from '../street.ts'
import type { LifeLayout } from '../townlife.ts'
import {
  ArenaParts,
  beam,
  cyl,
  hangLantern,
  hitchRail,
  placeAt,
  telegraphPole,
  wires,
  YAW,
} from './build.ts'
import { boxcar, caboose, flatcar, TRACK_X, track, waterTower, windmill } from './depot-rail.ts'
import type { Arena, ArenaCtx } from './types.ts'

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

/** The platform's lane edge and the depot's front wall (x), and the platform's run (z). */
const PLAT_X0 = 8.6
const WALL_X = 13
const PLAT_Z0 = -34
const PLAT_Z1 = 40
/** The depot: back wall, ends, side walls' height, ridge. */
const BACK_X = 20
const DEPOT_Z0 = -2
const DEPOT_Z1 = 26
const WALL_TOP = 4.2
const RIDGE_X = 16.5
const RIDGE_Y = 7
/** The platform canopy: its lane edge and height there, rising to the wall top. */
const CANOPY_X = 9.3
const CANOPY_Y = 3.55
const CANOPY_SLOPE = (WALL_TOP - CANOPY_Y) / (WALL_X - CANOPY_X)
/** Canopy posts (x) and where they stand along the platform. */
const POST_X = 9.55
const POSTS = [-1.5, 3.1, 7.7, 12.3, 16.9, 21.5, 26.1] as const

const PAINT = 0xc8_a8_6a
const TRIM = 0x4a_30_20
const WAINSCOT = 0x7a_5a_3a
const SHINGLE = 0xb4_a4_94
const IRON = 0x3a_36_32
const SOFFIT = 0x6a_4c_34

/** The canopy's underside height at x. */
const canopyUnder = (x: number): number => CANOPY_Y + (x - CANOPY_X) * CANOPY_SLOPE - 0.12

function platform(p: ArenaParts): void {
  const t = p.trim
  const len = PLAT_Z1 - PLAT_Z0
  const zc = (PLAT_Z0 + PLAT_Z1) / 2
  // the deck, its edge timber and the fascia down to the cinders
  t.box((PLAT_X0 + WALL_X) / 2, DECK / 2, zc, WALL_X - PLAT_X0, DECK, len, 0xc0_a8_88, {
    rotUV: true,
    skip: ['bottom'],
  })
  t.box(PLAT_X0 + 0.12, DECK + 0.03, zc, 0.24, 0.06, len, 0x8a_74_5a, { skip: ['bottom'] })
  // past the depot the platform runs on: its back edge closes on the cinders
  for (const [z0, z1] of [
    [PLAT_Z0, DEPOT_Z0],
    [DEPOT_Z1, PLAT_Z1],
  ] as const) {
    t.box(WALL_X + 0.6, DECK / 2, (z0 + z1) / 2, 1.2, DECK, z1 - z0, 0xc0_a8_88, {
      rotUV: true,
      skip: ['bottom'],
    })
  }
}

/** The depot's walls, battens, wainscot, doors, windows and the operator's bay. */
function depotWalls(p: ArenaParts): void {
  const t = p.trim
  const len = DEPOT_Z1 - DEPOT_Z0
  const zc = (DEPOT_Z0 + DEPOT_Z1) / 2
  const depth = BACK_X - WALL_X
  const xc = (WALL_X + BACK_X) / 2
  // the box, its gable ends closed up to the ridge
  t.box(xc, WALL_TOP / 2, zc, depth, WALL_TOP, len, PAINT, { skip: ['bottom', 'top'] })
  for (const z of [DEPOT_Z0, DEPOT_Z1]) {
    const f = z === DEPOT_Z0 ? -1 : 1
    const a = V(WALL_X, WALL_TOP, z)
    const b = V(BACK_X, WALL_TOP, z)
    const r = V(RIDGE_X, RIDGE_Y, z)
    if (f < 0) {
      t.tri(b, a, r, PAINT)
    } else {
      t.tri(a, b, r, PAINT)
    }
  }
  // battens on the lane face, a wainscot and its rail, corner boards, a frieze under the canopy
  for (let z = DEPOT_Z0 + 0.3; z < DEPOT_Z1 - 0.2; z += 0.62) {
    t.box(WALL_X - 0.025, 2.5, z, 0.05, 3.2, 0.07, 0xb8_98_5c)
  }
  t.box(WALL_X - 0.03, 0.5 + DECK / 2, zc, 0.06, 1.0 - DECK / 2, len, WAINSCOT)
  t.box(WALL_X - 0.06, 1.02, zc, 0.12, 0.08, len + 0.02, TRIM)
  t.box(WALL_X - 0.05, WALL_TOP - 0.2, zc, 0.1, 0.24, len + 0.02, TRIM)
  for (const z of [DEPOT_Z0, DEPOT_Z1]) {
    for (const x of [WALL_X, BACK_X]) {
      t.box(x, WALL_TOP / 2, z, 0.2, WALL_TOP, 0.2, TRIM)
    }
  }
  // doors: the waiting room, the ticket office (behind the fake-out's screen door), the freight
  const face = WALL_X
  const ry = YAW['-x']
  const kit = (name: string, z: number, depthOut: number, sx = 1) =>
    p.put(name, placeAt(face - depthOut, DECK, z, ry).scale(V(sx, 1, 1)))
  for (const z of [4, 17.5]) {
    kit('k_door', z, 0.06)
    kit('k_doorframe', z, 0.12)
  }
  kit('k_door_braced', 21 - 0.44, 0.06, 0.78)
  kit('k_door_braced', 21 + 0.44, 0.06, 0.78)
  kit('k_doorframe', 21, 0.12, 1.5)
  for (const z of [0.6, 7.6, 10.2, 24.4]) {
    kit('k_window_wide', z, 0.02)
  }
  // the operator's bay: out over the platform, glazed on three sides
  const bz0 = 12.4
  const bz1 = 15.4
  const bx = WALL_X - 1
  t.box(bx + 0.5, 1.8 + DECK / 2, (bz0 + bz1) / 2, 1, 3.6 - DECK, bz1 - bz0, PAINT, {
    skip: ['bottom', 'px'],
  })
  t.box(bx + 0.45, 3.82, (bz0 + bz1) / 2, 1.3, 0.16, bz1 - bz0 + 0.3, TRIM)
  // its little hipped roof, shingled, under the canopy
  const bm = p.m.cell('slate')
  bm.quad(
    V(bx - 0.2, 3.9, bz0 - 0.15),
    V(bx - 0.2, 3.9, bz1 + 0.15),
    V(WALL_X, 4.15, bz1),
    V(WALL_X, 4.15, bz0),
    SHINGLE,
  )
  kit('k_window_thin', (bz0 + bz1) / 2, 1.02)
  for (const [z, f] of [
    [bz0, '-z'],
    [bz1, '+z'],
  ] as const) {
    p.put(
      'k_window_thin',
      placeAt(bx + 0.5, DECK, z + (f === '-z' ? -0.02 : 0.02), YAW[f]).scale(V(0.62, 1, 1)),
    )
  }
  // the gable ends' bargeboards
  for (const z of [DEPOT_Z0 - 0.62, DEPOT_Z1 + 0.62]) {
    beam(t, V(WALL_X - 0.05, WALL_TOP + 0.02, z), V(RIDGE_X, RIDGE_Y + 0.12, z), 0.06, 0.26, TRIM)
    beam(t, V(BACK_X + 0.05, WALL_TOP + 0.02, z), V(RIDGE_X, RIDGE_Y + 0.12, z), 0.06, 0.26, TRIM)
  }
}

/** The roof: two pitches over the depot, the canopy over the platform, posts and knee braces. */
function depotRoof(p: ArenaParts): void {
  const s = p.m.cell('slate')
  const z0 = DEPOT_Z0 - 0.6
  const z1 = DEPOT_Z1 + 0.6
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => s.quad(a, b, c, d, SHINGLE, true)
  // main pitches (wound to face up and out)
  quad(
    V(WALL_X, WALL_TOP, z1),
    V(WALL_X, WALL_TOP, z0),
    V(RIDGE_X, RIDGE_Y, z0),
    V(RIDGE_X, RIDGE_Y, z1),
  )
  quad(
    V(BACK_X + 0.6, WALL_TOP - 0.48, z0),
    V(BACK_X + 0.6, WALL_TOP - 0.48, z1),
    V(RIDGE_X, RIDGE_Y, z1),
    V(RIDGE_X, RIDGE_Y, z0),
  )
  // the canopy pitch, shallower, out to its fascia
  quad(
    V(CANOPY_X, CANOPY_Y, z1),
    V(CANOPY_X, CANOPY_Y, z0),
    V(WALL_X, WALL_TOP, z0),
    V(WALL_X, WALL_TOP, z1),
  )
  p.m.cell('tin').box(RIDGE_X, RIDGE_Y + 0.04, (z0 + z1) / 2, 0.24, 0.1, z1 - z0 + 0.1, 0x8a_86_80)
  const t = p.trim
  // the canopy's boarded underside and its fascia (seen from the lane: the camera is below it)
  t.quad(
    V(CANOPY_X, CANOPY_Y - 0.12, z0),
    V(CANOPY_X, CANOPY_Y - 0.12, z1),
    V(WALL_X, WALL_TOP - 0.12, z1),
    V(WALL_X, WALL_TOP - 0.12, z0),
    SOFFIT,
    true,
  )
  t.box(CANOPY_X + 0.03, CANOPY_Y - 0.14, (z0 + z1) / 2, 0.06, 0.32, z1 - z0, TRIM)
  // the eave plate the posts carry, the posts, and a knee brace each side of every post
  t.box(POST_X, canopyUnder(POST_X) - 0.1, (z0 + z1) / 2, 0.2, 0.2, z1 - z0 - 0.4, TRIM)
  for (const z of POSTS) {
    const top = canopyUnder(POST_X) - 0.2
    t.box(POST_X, (DECK + top) / 2, z, 0.2, top - DECK, 0.2, TRIM)
    t.box(POST_X, DECK + 0.05, z, 0.3, 0.1, 0.3, TRIM)
    for (const dz of [-1, 1]) {
      beam(t, V(POST_X, top - 0.8, z), V(POST_X, top - 0.05, z + dz * 0.8), 0.1, 0.1, TRIM)
    }
    // and a bracket from the wall out to the plate
    beam(t, V(WALL_X - 0.05, 2.9, z), V(POST_X + 0.3, top - 0.05, z), 0.1, 0.12, TRIM)
  }
}

/** Signs: the station's name, tickets, the waiting room, the freight house. */
function signs(p: ArenaParts): void {
  const name = { text: 'PERDITION', bg: '#f0e2bc', fg: '#2a1a10' }
  p.board(name, RIDGE_X, 5.05, DEPOT_Z0 - 0.06, '-z', 4.4, 0.78)
  p.board(name, RIDGE_X, 5.05, DEPOT_Z1 + 0.06, '+z', 4.4, 0.78)
  // a name board hung under the canopy, edge-on to the lane (both faces): read down the lane
  const hz = 13.9
  const t = p.trim
  t.box(11.2, 3.0, hz, 2.9, 0.62, 0.06, TRIM)
  for (const dx of [-1, 1]) {
    t.box(11.2 + dx * 1.2, 3.42, hz, 0.03, 0.26, 0.03, 0x2a_2a_2a)
  }
  p.board(name, 11.2, 3.0, hz - 0.035, '-z', 2.7, 0.5)
  p.board(name, 11.2, 3.0, hz + 0.035, '+z', 2.7, 0.5)
  p.board(
    { text: 'TICKETS', bg: '#2a3a2a', fg: '#efe0b0' },
    WALL_X - 0.07,
    3.15,
    17.5,
    '-x',
    1.6,
    0.36,
  )
  p.board(
    { text: 'WAITING ROOM', bg: '#3a2a1c', fg: '#ecd9a8' },
    WALL_X - 0.07,
    3.15,
    4,
    '-x',
    2.2,
    0.36,
  )
  p.board(
    { text: 'BAGGAGE & EXPRESS', bg: '#3a1e14', fg: '#f0d9a0' },
    WALL_X - 0.07,
    3.3,
    21,
    '-x',
    2.9,
    0.36,
  )
}

/** The train-order mast by the bay, the station bell, benches, baggage and the dressing. */
function platformLife(p: ArenaParts): void {
  const t = p.trim
  // the train-order signal: a tall mast, two blades out over the line, a lamp between
  const mx = 9.05
  const mz = 13.9
  t.box(mx, DECK + 3.6, mz, 0.18, 7.2, 0.18, 0x3a_3a_36)
  t.box(mx, DECK + 7.25, mz, 0.3, 0.1, 0.3, 0x3a_3a_36)
  for (const dz of [-1, 1]) {
    t.box(mx - 0.12, DECK + 6.5, mz + dz * 0.75, 0.05, 0.24, 1.3, 0xb0_2a_1e)
    t.box(mx - 0.12, DECK + 6.5, mz + dz * 1.32, 0.05, 0.26, 0.16, 0xe8_e0_d0)
  }
  p.glass.box(mx - 0.14, DECK + 6.15, mz, 0.2, 0.28, 0.2, 0xff_ff_ff)
  // a ladder up it
  for (let y = 0.6; y < 6; y += 0.4) {
    t.box(mx + 0.16, DECK + y, mz, 0.04, 0.04, 0.42, 0x2a_2a_26)
  }
  // the station bell on its frame
  const bz = 9.1
  for (const dz of [-0.4, 0.4]) {
    t.box(10.1, DECK + 1.4, bz + dz, 0.12, 2.8, 0.12, TRIM)
  }
  t.box(10.1, DECK + 2.82, bz, 0.16, 0.14, 1.0, TRIM)
  const bell = p.m.cell('tin')
  cyl(bell, 10.1, DECK + 2.18, bz, 0.26, 0.12, 0.42, 10, 0x6a_50_30)
  bell.box(10.1, DECK + 2.66, bz, 0.08, 0.12, 0.08, 0x3a_30_24)
  // benches against the depot, facing the lane
  for (const z of [1, 10.4, 24.2]) {
    p.put('k_bench', placeAt(WALL_X - 0.55, DECK, z, YAW['-x']))
  }
  // trunks and a sack pile by the bay, milk cans and crates by the freight door
  p.put('k_chest', placeAt(WALL_X - 0.5, DECK, 15.95, YAW['-x']))
  p.put('k_chest', placeAt(WALL_X - 0.45, DECK, 16.65, YAW['-x'] + 0.2, 0.9))
  p.put('k_sack', placeAt(WALL_X - 0.5, DECK, 19.5, 1.1))
  p.put('k_sack', placeAt(WALL_X - 0.45, DECK, 19.9, 2.3, 0.9))
  p.prop('barrel', 0.95, 'y', placeAt(WALL_X - 0.5, DECK, 23, 0.4, 0.8))
  p.prop('barrel', 0.95, 'y', placeAt(WALL_X - 1.15, DECK, 23.2, 1.7, 0.8))
  p.prop('crate', 0.85, 'y', placeAt(12.3, DECK, -5.2, 0.2))
  p.prop('crate', 0.85, 'y', placeAt(12.35, DECK, -6.3, -0.15, 0.9))
  p.prop('crate', 0.85, 'y', placeAt(12.3, DECK + 0.85, -5.7, 0.5, 0.8))
  // the baggage cart, waiting for the westbound
  p.prop('cart', 2.8, 'max', placeAt(11.1, DECK, 6.3, 0.05))
  // the hitching rails at the platform's ends
  hitchRail(t, PLAT_X0 - 0.2, 30.5, 'z')
  hitchRail(t, -8.4, -15, 'z')
}

/** Board-and-batten freight house down the lane, its gable to the camera. */
function freightHouse(p: ArenaParts): void {
  const w = p.walls
  const x0 = 10.5
  const x1 = 19.5
  const z0 = 44
  const z1 = 56
  const xc = (x0 + x1) / 2
  const color = 0x9a_86_6e
  w.box(xc, 2.25, (z0 + z1) / 2, x1 - x0, 4.5, z1 - z0, color, { skip: ['bottom', 'top'] })
  w.tri(V(x1, 4.5, z0), V(x0, 4.5, z0), V(xc, 7.2, z0), color)
  w.tri(V(x0, 4.5, z1), V(x1, 4.5, z1), V(xc, 7.2, z1), color)
  p.m.cell('tin').gable(xc, 4.5, (z0 + z1) / 2, x1 - x0, z1 - z0, 2.7, 'z', 0xa8_9c_90, 0.4)
  // the sliding doors on the gable, the dock in front, the sign
  p.trim.box(xc, 1.6 + 1.1, z0 - 0.06, 3.2, 2.6, 0.1, 0x5a_40_2c)
  p.trim.box(xc, 4.05, z0 - 0.1, 4.4, 0.08, 0.1, IRON)
  p.trim.box(xc, 0.55, z0 - 1.2, x1 - x0 + 0.4, 1.1, 2.4, 0xb0_98_78, {
    rotUV: true,
    skip: ['bottom'],
  })
  p.board(
    { text: 'FREIGHT HOUSE', bg: '#ecdcb8', fg: '#3a2416' },
    xc,
    5.05,
    z0 - 0.06,
    '-z',
    4.2,
    0.6,
  )
  p.prop('crate', 0.85, 'y', placeAt(x0 + 1, 1.1, z0 - 1.5, 0.2))
  p.prop('barrel', 0.95, 'y', placeAt(x1 - 1.2, 1.1, z0 - 1.1, 0.6))
}

/** Stock pens out past the freight house, and a fence along the lane's end. */
function pens(p: ArenaParts): void {
  for (let i = 0; i < 4; i++) {
    p.prop('fence', 5.9, 'max', placeAt(9.4, 0, 62 + i * 5.9, Math.PI / 2))
    p.prop('fence', 5.9, 'max', placeAt(21.2, 0, 62 + i * 5.9, Math.PI / 2))
  }
  for (let i = 0; i < 2; i++) {
    p.prop('fence', 5.9, 'max', placeAt(12.35 + i * 5.9, 0, 59.05, 0))
  }
  p.prop('hay', 1.3, 'y', placeAt(13.5, 0, 66, 0.3))
  p.prop('hay', 1.3, 'y', placeAt(17.8, 0, 72, 1.2))
}

/** The section house behind the player, and the express shed and its dock across the line. */
function behind(p: ArenaParts): void {
  const w = p.walls
  // section house: low, red, gable along the lane
  const color = 0x9a_5a_44
  w.box(14.5, 1.8, -19, 7, 3.6, 12, color, { skip: ['bottom', 'top'] })
  w.tri(V(18, 3.6, -25), V(11, 3.6, -25), V(14.5, 5.6, -25), color)
  w.tri(V(11, 3.6, -13), V(18, 3.6, -13), V(14.5, 5.6, -13), color)
  p.m.cell('slate').gable(14.5, 3.6, -19, 7, 12, 2, 'z', SHINGLE, 0.45)
  p.put('k_door', placeAt(11 - 0.06, DECK, -19, YAW['-x']))
  p.put('k_doorframe', placeAt(11 - 0.12, DECK, -19, YAW['-x']))
  for (const z of [-22.5, -15.5]) {
    p.put('k_window_wide', placeAt(11 - 0.02, DECK, z, YAW['-x']))
  }
  // across the line: the express shed with a dock at car-floor height
  const ex = -20
  const ecolor = 0x8a_7a_62
  w.box(ex, 2.4, -5, 8, 4.8, 18, ecolor, { skip: ['bottom', 'top'] })
  w.tri(V(ex - 4, 4.8, -14), V(ex + 4, 4.8, -14), V(ex, 6.6, -14), ecolor)
  w.tri(V(ex + 4, 4.8, 4), V(ex - 4, 4.8, 4), V(ex, 6.6, 4), ecolor)
  p.m.cell('tin').gable(ex, 4.8, -5, 8, 18, 1.8, 'z', 0xa8_9c_90, 0.5)
  p.trim.box(-15.2, 0.55, -5, 1.6, 1.1, 18, 0xb0_98_78, { rotUV: true, skip: ['bottom'] })
  p.trim.box(-15.2, 3.6, -5, 1.8, 0.1, 18.4, 0x5a_44_30)
  for (const z of [-13.5, -9, -4.5, 0, 3.5]) {
    p.trim.box(-14.45, 2.35, z, 0.14, 2.5, 0.14, 0x5a_44_30)
  }
  p.trim.box(ex + 4.03, 2.2, -5, 0.08, 2.2, 3, 0x5a_40_2c)
  p.board({ text: 'EXPRESS', bg: '#2a3a2e', fg: '#e8dcc0' }, ex + 4.06, 4.1, -5, '+x', 2.4, 0.42)
  p.prop('crate', 0.85, 'y', placeAt(-15.2, 1.1, -10.5, 0.2))
  p.prop('crate', 0.85, 'y', placeAt(-15.3, 1.1, -1.5, -0.3, 1.1))
  p.prop('barrel', 0.95, 'y', placeAt(-15.4, 1.1, 1, 0.5))
}

/** Telegraph poles along the far side of the line, and their wires. */
function poleLine(p: ArenaParts): void {
  let last: Vector3[] | null = null
  for (let z = -110; z <= 210; z += 15) {
    const tips = telegraphPole(p, -15.8, z)
    if (last) {
      wires(p.trim, last, tips)
    }
    last = tips
  }
}

function lifeLayout(): LifeLayout {
  const faceR = -Math.PI / 2
  const faceL = Math.PI / 2
  const seat = DECK + 0.42
  const bench = WALL_X - 0.63
  return {
    folk: [
      { x: bench, y: seat, z: 10.4, yaw: faceR, habit: 'sit', door: [WALL_X + 0.3, 4], lane: 10.4 },
      {
        x: POST_X + 0.28,
        y: DECK,
        z: 21.75,
        yaw: faceR - 0.35,
        habit: 'lean',
        door: [WALL_X + 0.3, 21],
        lane: 10.4,
      },
      { x: -10.1, y: 0, z: 26.2, yaw: faceL - 0.3, habit: 'stand', door: null, floor: 0 },
      { x: 10.1, y: DECK, z: 31.8, yaw: faceR - 0.5, habit: 'stand', door: null },
      {
        x: bench,
        y: seat,
        z: 24.2,
        yaw: faceR,
        habit: 'whittle',
        door: [WALL_X + 0.3, 21],
        lane: 10.4,
      },
      {
        x: WALL_X - 0.4,
        y: DECK,
        z: 4.1,
        yaw: faceR - 0.4,
        habit: 'door',
        door: [WALL_X + 0.3, 4],
        lane: 11.5,
      },
      {
        x: 11.6,
        y: DECK,
        z: 16.2,
        yaw: faceR + 0.3,
        habit: 'stand',
        door: [WALL_X + 0.3, 17.5],
        lane: 11.6,
      },
      { x: -9.9, y: 0, z: 11.6, yaw: faceL + 0.35, habit: 'stand', door: null, floor: 0 },
      { x: bench, y: seat, z: 1, yaw: faceR, habit: 'sit', door: null },
    ],
    // along the near edge of the first boxcar's roof, in the standoff's frame beyond the outlaw
    crows: { x: TRACK_X + 1.25, y: 4.04, z: 18.6, along: 'z', face: Math.PI / 2 },
    horses: [
      { x: PLAT_X0 - 1.6, y: 0, z: 30.5, yaw: Math.PI / 2 },
      { x: -7.15, y: 0, z: -15, yaw: -Math.PI / 2 },
    ],
    dog: { x: 9.95, y: DECK, z: 18.3, yaw: faceR },
    door: { x: WALL_X - 0.15, y: DECK, z: 17.05, yaw: 0 },
    hens: null,
  }
}

export function build(ctx: ArenaCtx): Arena {
  const p = new ArenaParts(ctx, 'depot')
  platform(p)
  depotWalls(p)
  depotRoof(p)
  signs(p)
  platformLife(p)
  track(p)
  boxcar(p, 13, 23.4, 0x74_30_24, false)
  boxcar(p, 24.4, 34.6, 0x6a_4a_32, true)
  flatcar(p, 35.6, 43.4)
  caboose(p, 44.4, 51.4)
  waterTower(p, -16.8, 60)
  windmill(p, 16, 70)
  freightHouse(p)
  pens(p)
  behind(p)
  poleLine(p)
  // the canopy lanterns, and the switch lamp
  const lamps: [number, number, number][] = []
  for (const z of [1.2, 7.7, 16.9, 23.6]) {
    lamps.push([10.2, hangLantern(p, 10.2, canopyUnder(10.2), z), z])
  }
  lamps.push([-10.4, 1.59, 6])
  lamps.push([-15.2, hangLantern(p, -15.2, 3.55, -5), -5])
  p.finish()
  const pools = [
    ...lamps.map(([x, , z]) => new Vector4(x * 0.96, z, 4.2, 1)),
    ...[0.6, 7.6, 10.2, 13.9, 24.4].map((z) => new Vector4(WALL_X - 0.9, z, 3, -0.55)),
  ]
  return {
    id: 'depot',
    root: p.root,
    lanterns: lamps,
    pools,
    bell: V(10.1, DECK + 2.3, 9.1),
    life: lifeLayout(),
    ruts: 0.55,
    dispose: () => p.dispose(),
  }
}
