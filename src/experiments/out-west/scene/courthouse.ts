// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * The courthouse under the clock tower: a two-storey brick hall on a sandstone plinth, with
 * quoined corners, pilastered bays, string course and bracketed cornice, a hipped cedar-shingle
 * roof and two chimneys, and a timber portico with steps in front of the tower door. Windows and
 * doors are the Quaternius kit pieces (merged with the street's kit draw; their glass lights up
 * with the street's windows at night).
 */
import { Matrix4, Vector3 } from 'three'
import type { GeoBuilder } from './geo.ts'
import type { Masonry } from './masonry.ts'
import { type PropDef, placeMatrix, propDef, propsLibrary } from './props.ts'

export const BRICK = 0xe6_d2_c4
export const STONE = 0xf4_ea_dc
export const SHINGLE = 0xc4_ae_96
export const TIN = 0xb4_b2_ae
export const PAINT = 0xd8_cc_b0
export const DARK_WOOD = 0x3a_2a_1e

export type Placed = { def: PropDef; at: Matrix4 }

export interface Parts {
  m: Masonry
  /** The street's painted-plank trim batch (World.trimMat). */
  trim: GeoBuilder
  /** The street's night-lit glass batch (World.windowMat). */
  glass: GeoBuilder
  /** Kit pieces merged with the street's. */
  kit: Placed[]
}

/** A wall plane: outward normal (one of ±x, -z, +z) and its offset along that axis. */
export interface Face {
  nx: number
  nz: number
  d: number
}

/**
 * A box against a wall: `a` along the wall, `y` its centre height, `w` x `h` on the face,
 * from 0.1 inside the wall to `proud` in front of it.
 */
export function boxOn(
  b: GeoBuilder,
  f: Face,
  a: number,
  y: number,
  w: number,
  h: number,
  proud: number,
  color: number,
): void {
  const depth = proud + 0.1
  if (f.nz === 0) {
    b.box(f.d + (Math.sign(f.nx) * (proud - 0.1)) / 2, y, a, depth, h, w, color)
  } else {
    b.box(a, y, f.d + (Math.sign(f.nz) * (proud - 0.1)) / 2, w, h, depth, color)
  }
}

/** Alternating long and short sandstone quoins up a corner; `sx`, `sz` point outward. */
export function quoins(
  b: GeoBuilder,
  x: number,
  z: number,
  sx: number,
  sz: number,
  y0: number,
  y1: number,
  h = 0.34,
): void {
  const p = 0.045
  for (let k = 0, y = y0; y < y1 - 0.08; k++, y += h) {
    const top = Math.min(y + h, y1)
    const lx = k % 2 === 1 ? 0.62 : 0.4
    const lz = k % 2 === 1 ? 0.4 : 0.62
    const xa = x - sx * lx
    const xb = x + sx * p
    const za = z - sz * lz
    const zb = z + sz * p
    b.box(
      (xa + xb) / 2,
      (y + top) / 2,
      (za + zb) / 2,
      Math.abs(xb - xa),
      top - y - 0.018,
      Math.abs(zb - za),
      STONE,
      { skip: ['bottom'] },
    )
  }
}

function kitPiece(name: string): PropDef | null {
  const lib = propsLibrary()
  return lib ? propDef(lib, name, 1, 'y', true) : null
}

/** The kit's rotation that turns its +Z face to the face's outward normal. */
export function faceYaw(f: Face): number {
  if (f.nz !== 0) {
    return f.nz > 0 ? 0 : Math.PI
  }
  return f.nx > 0 ? Math.PI / 2 : -Math.PI / 2
}

/** World point on a face: `a` along it, `out` in front of it. */
export function onFace(f: Face, a: number, y: number, out: number): Vector3 {
  return f.nz === 0
    ? new Vector3(f.d + Math.sign(f.nx) * out, y, a)
    : new Vector3(a, y, f.d + Math.sign(f.nz) * out)
}

/**
 * A tall sash window: the kit's thin window stretched to courthouse proportions, a sandstone
 * sill and a lintel with a keystone. `sill` is the height of the sill's top.
 */
export function sashWindow(p: Parts, f: Face, a: number, sill: number): void {
  const sx = 1.25
  const sy = 1.38
  const win = kitPiece('k_window_thin')
  const glassBottom = 0.97 * sy
  const top = sill + (2.53 - 0.97) * sy
  if (win) {
    const at = onFace(f, a, sill - glassBottom, 0.02)
    p.kit.push({
      def: win,
      at: placeMatrix(at.x, at.y, at.z, faceYaw(f)).scale(new Vector3(sx, sy, 1)),
    })
  } else {
    boxOn(p.glass, f, a, (sill + top) / 2, 0.95, top - sill, 0.02, 0xff_ff_ff)
    boxOn(p.trim, f, a, (sill + top) / 2, 1.1, top - sill + 0.1, 0.01, PAINT)
  }
  const s = p.m.cell('stone')
  boxOn(s, f, a, sill - 0.06, 1.34, 0.12, 0.16, STONE)
  boxOn(s, f, a, top + 0.17, 1.46, 0.34, 0.07, STONE)
  boxOn(s, f, a, top + 0.2, 0.26, 0.44, 0.11, STONE)
}

const HALL_W = 6
const PLINTH = 0.9
const COURSE = 4.6
const EAVE = 8.4

/** The hall: plinth, walls, bands, pilasters, quoins, windows, cornice, roof and chimneys. */
export function buildHall(p: Parts, cz: number, towerHalf: number): void {
  const z0 = cz - 1
  const z1 = cz + 15
  const zc = (z0 + z1) / 2
  const depth = z1 - z0
  const w = HALL_W
  const s = p.m.cell('stone')
  const br = p.m.cell('brick')
  s.box(0, PLINTH / 2, zc, w * 2 + 0.16, PLINTH, depth + 0.16, STONE, { skip: ['bottom'] })
  br.box(0, (PLINTH + EAVE) / 2, zc, w * 2, EAVE - PLINTH, depth, BRICK, {
    skip: ['bottom', 'top'],
  })
  s.box(0, COURSE, zc, w * 2 + 0.12, 0.2, depth + 0.12, STONE, { skip: ['bottom'] })
  // cornice: two stepped stone courses with timber brackets beneath
  s.box(0, EAVE + 0.12, zc, w * 2 + 0.36, 0.24, depth + 0.36, STONE)
  s.box(0, EAVE + 0.32, zc, w * 2 + 0.62, 0.16, depth + 0.62, STONE)
  for (const sx of [-1, 1]) {
    for (let z = z0 + 0.5; z < z1; z += 0.8) {
      p.trim.box(sx * (w + 0.1), EAVE - 0.12, z, 0.2, 0.24, 0.12, DARK_WOOD)
    }
    for (let x = towerHalf + 0.4; x < w; x += 0.8) {
      p.trim.box(sx * x, EAVE - 0.12, z0 - 0.1, 0.12, 0.24, 0.2, DARK_WOOD)
    }
  }
  // pilasters between the side bays, quoins on every corner
  for (const sx of [-1, 1]) {
    const f: Face = { nx: sx, nz: 0, d: sx * w }
    for (const z of [cz + 3, cz + 7, cz + 11]) {
      boxOn(br, f, z, (PLINTH + EAVE) / 2, 0.56, EAVE - PLINTH, 0.08, BRICK)
    }
    quoins(s, sx * w, z0, sx, -1, PLINTH, EAVE)
    quoins(s, sx * w, z1, sx, 1, PLINTH, EAVE)
    for (const z of [cz + 1, cz + 5, cz + 9, cz + 13]) {
      sashWindow(p, f, z, 1.9)
      sashWindow(p, f, z, 5.55)
    }
    const front: Face = { nx: 0, nz: -1, d: z0 }
    const wx = sx * (towerHalf + (w - towerHalf) / 2)
    sashWindow(p, front, wx, 1.9)
    sashWindow(p, front, wx, 5.55)
    const back: Face = { nx: 0, nz: 1, d: z1 }
    sashWindow(p, back, sx * 2.6, 1.9)
    sashWindow(p, back, sx * 2.6, 5.55)
  }
  hipRoof(p, 0, EAVE + 0.4, zc, w * 2 + 0.9, depth + 0.9, 3.1)
  for (const sx of [-1, 1]) {
    br.box(sx * 3.7, 11.4, cz + 11.5, 0.8, 4.2, 1.0, BRICK, { skip: ['bottom'] })
    s.box(sx * 3.7, 13.58, cz + 11.5, 1.0, 0.16, 1.2, STONE)
    s.box(sx * 3.7, 13.74, cz + 11.5, 0.84, 0.16, 1.04, STONE)
  }
}

/** A hipped roof over a footprint (x along the narrow side), shingled. */
function hipRoof(p: Parts, cx: number, y: number, cz: number, sx: number, sz: number, h: number) {
  const b = p.m.cell('slate')
  const hx = sx / 2
  const hz = sz / 2
  const ridge = Math.max(0, hz - hx)
  const V = (x: number, yy: number, z: number) => new Vector3(x, yy, z)
  const a = V(cx - hx, y, cz - hz)
  const bb = V(cx + hx, y, cz - hz)
  const c = V(cx + hx, y, cz + hz)
  const d = V(cx - hx, y, cz + hz)
  const r0 = V(cx, y + h, cz - ridge)
  const r1 = V(cx, y + h, cz + ridge)
  b.tri(bb, a, r0, SHINGLE)
  b.tri(d, c, r1, SHINGLE)
  // the long slopes run along Z: shingle courses along Z (rotated planar UVs)
  b.quad(c, bb, r0, r1, SHINGLE, true)
  b.quad(a, d, r1, r0, SHINGLE, true)
  // tin ridge and hip flashing
  const t = p.m.cell('tin')
  t.box(cx, y + h + 0.03, cz, 0.18, 0.08, ridge * 2 + 0.1, TIN)
}

/**
 * The portico before the tower door: a sandstone platform and steps, square painted posts,
 * an entablature and a shingled pediment, the double doors with a lit transom, and two lanterns.
 */
export function buildPortico(p: Parts, front: number): void {
  const s = p.m.cell('stone')
  const t = p.trim
  const z0 = front - 1.55
  const zc = (z0 + front) / 2
  s.box(0, PLINTH / 2, zc, 4.7, PLINTH, front - z0, STONE, { skip: ['bottom'] })
  s.box(0, 0.3, z0 - 0.18, 3.8, 0.6, 0.36, STONE, { skip: ['bottom'] })
  s.box(0, 0.15, z0 - 0.54, 3.8, 0.3, 0.36, STONE, { skip: ['bottom'] })
  // cheek walls flanking the steps
  for (const sx of [-1, 1]) {
    s.box(sx * 2.12, 0.45, z0 - 0.36, 0.46, 0.9, 0.72, STONE, { skip: ['bottom'] })
  }
  const top = 3.6
  for (const sx of [-1, 1]) {
    const x = sx * 1.95
    const z = z0 + 0.3
    t.box(x, PLINTH + 0.1, z, 0.42, 0.2, 0.42, PAINT)
    t.box(x, (PLINTH + top) / 2 + 0.05, z, 0.26, top - PLINTH - 0.1, 0.26, PAINT)
    t.box(x, top - 0.08, z, 0.38, 0.14, 0.38, PAINT)
    // a pilaster where the beam meets the tower
    t.box(x, (PLINTH + top) / 2, front - 0.06, 0.3, top - PLINTH, 0.12, PAINT)
  }
  // entablature: beam, frieze board and cornice
  t.box(0, top + 0.17, z0 + 0.3, 4.4, 0.34, 0.3, PAINT)
  for (const sx of [-1, 1]) {
    t.box(sx * 2.05, top + 0.17, zc + 0.15, 0.3, 0.34, front - z0 - 0.3, PAINT)
  }
  t.box(0, top + 0.4, zc, 4.7, 0.12, front - z0 + 0.3, DARK_WOOD)
  t.box(0, top + 0.02, zc + 0.15, 3.9, 0.04, front - z0 - 0.3, 0x5a_4a_3a)
  pediment(p, top + 0.46, z0 - 0.15, front)
  // the doors: two kit leaves under a glazed transom, in a painted frame
  const door = kitPiece('k_door')
  const frame = kitPiece('k_doorframe')
  if (door && frame) {
    p.kit.push({ def: door, at: placeMatrix(1.07, PLINTH, front - 0.06, Math.PI) })
    p.kit.push({ def: door, at: placeMatrix(0, PLINTH, front - 0.06, Math.PI) })
    p.kit.push({
      def: frame,
      at: placeMatrix(0, PLINTH, front - 0.1, Math.PI).scale(new Vector3(1.42, 1.0, 1)),
    })
  } else {
    t.box(0, PLINTH + 1.05, front - 0.04, 2.1, 2.1, 0.08, DARK_WOOD)
  }
  p.glass.box(0, PLINTH + 2.55, front - 0.03, 2.1, 0.45, 0.04, 0xff_ff_ff)
  t.box(0, PLINTH + 2.32, front - 0.06, 2.3, 0.08, 0.1, PAINT)
  t.box(0, PLINTH + 2.82, front - 0.06, 2.3, 0.1, 0.1, PAINT)
  const lantern = kitPiece('k_lantern')
  if (lantern) {
    for (const sx of [-1, 1]) {
      p.kit.push({
        def: lantern,
        at: placeMatrix(sx * 1.5, 1.75, front - 0.02, Math.PI, 0.75),
      })
    }
  }
}

/** The portico's gable: shingled slopes over a painted tympanum with raking boards. */
function pediment(p: Parts, y: number, z0: number, z1: number): void {
  const b = p.m.cell('slate')
  const hx = 2.5
  const h = 1.05
  const V = (x: number, yy: number, z: number) => new Vector3(x, yy, z)
  b.quad(V(-hx, y, z0), V(-hx, y, z1), V(0, y + h, z1), V(0, y + h, z0), SHINGLE, true)
  b.quad(V(hx, y, z1), V(hx, y, z0), V(0, y + h, z0), V(0, y + h, z1), SHINGLE, true)
  const tz = z0 + 0.12
  p.trim.tri(V(hx - 0.2, y, tz), V(-hx + 0.2, y, tz), V(0, y + h - 0.12, tz), PAINT)
  // raking boards along both slopes
  const len = Math.hypot(hx, h)
  const ang = Math.atan2(h, hx)
  for (const sx of [-1, 1]) {
    const m = new Matrix4()
      .makeTranslation(sx * hx * 0.5, y + h * 0.5, z0 + 0.02)
      .multiply(new Matrix4().makeRotationZ(-sx * ang))
    const corners = [
      [-len / 2, -0.06],
      [len / 2, -0.06],
      [len / 2, 0.12],
      [-len / 2, 0.12],
    ].map(([u = 0, v = 0]) => new Vector3(u, v, 0).applyMatrix4(m))
    const [c0, c1, c2, c3] = corners as [Vector3, Vector3, Vector3, Vector3]
    p.trim.quad(c1, c0, c3, c2, PAINT)
  }
}
