// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: place() is one switch, a case per cover kind
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: placement loops over layout rects
// biome-ignore-all lint/complexity/useMaxParams: placement and geometry helpers take positional numeric args
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one builder per cover kind, sharing the fit and cylinder helpers
// biome-ignore-all lint/style/noMagicNumbers: prop proportions in metres, tuned against the eye-level camera
/**
 * Cover and set dressing from the layout. Every cover rect is exactly what blocks movement and
 * bullets on the server, so every kind here fills its rect and nothing more: barrels, crates and
 * hay are instanced kit props fitted to their cells; fences are kit sections stretched to the run;
 * troughs, hitching rails, wagons, coaches, boxcars, lumber, wells and the rest are built into the
 * town's merged geometry (planks, painted boards, brick, canvas). Rocks, cacti and the boundary
 * fence come from `outskirts.ts` and stay outside the playable square.
 */
import {
  type BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GeoBuilder } from '../../scene/geo.ts'
import { instance, type PropDef, propDef } from '../../scene/props.ts'
import type { Cover, Rect, TownLayout } from '../sim/layout.ts'
import { OUTSKIRTS_SEED, outskirtsProps } from './outskirts.ts'

const DARK_WOOD = 0x6a_4c_34
const WEATHERED = 0x8a_74_5a
const IRON = 0x3a_38_36
const CANVAS = 0xe8_dc_c0

/** The builders the town merges everything into (one draw per material). */
export interface DressBuilders {
  wood: GeoBuilder
  wall: GeoBuilder
  stone: GeoBuilder
  cloth: GeoBuilder
  /** Extra wood-material geometry (wheels, logs, tanks), merged with `wood`. */
  extra: BufferGeometry[]
}

/** Deterministic jitter so the town looks the same for everyone. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10_000) / 10_000
  }
}

type Placed = Map<string, Matrix4[]>

function put(p: Placed, name: string, m: Matrix4): void {
  const list = p.get(name)
  if (list) {
    list.push(m)
  } else {
    p.set(name, [m])
  }
}

/** Kit props normalised to 1 m along x, so their proportions are known for fitting. */
const UNIT: Record<string, 'x' | 'y' | 'max'> = {
  barrel: 'y',
  crate: 'y',
  hay: 'x',
  fence: 'x',
  k_bench: 'max',
  k_table: 'max',
  k_chair: 'max',
  k_anvil: 'max',
  coffin: 'max',
  k_bucket: 'max',
  k_sack: 'max',
}

/**
 * A prop stretched to fill a ground rect (`w` along x, `d` along z), its long side along the
 * rect's long side, `h` tall (or scaled with its footprint).
 */
function fitTo(
  def: PropDef,
  cx: number,
  y: number,
  cz: number,
  w: number,
  d: number,
  h?: number,
  ry = 0,
): Matrix4 {
  const propLongX = def.size.x >= def.size.z
  const rectLongX = w >= d
  const turn = propLongX !== rectLongX
  const alongLen = turn ? d : w
  const acrossLen = turn ? w : d
  const sx = alongLen / Math.max(1e-3, def.size.x)
  const sz = acrossLen / Math.max(1e-3, def.size.z)
  const sy = h === undefined ? (sx + sz) / 2 : h / Math.max(1e-3, def.size.y)
  return new Matrix4().compose(
    new Vector3(cx, y, cz),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (turn ? Math.PI / 2 : 0) + ry),
    new Vector3(sx, sy, sz),
  )
}

/** Cells of about `cell` metres tiling a rect; `cb` gets each cell's centre and size. */
function cells(
  c: Rect,
  cell: number,
  cb: (x: number, z: number, w: number, d: number, i: number) => void,
): void {
  const nx = Math.max(1, Math.round(c.w / cell))
  const nz = Math.max(1, Math.round(c.d / cell))
  const w = c.w / nx
  const d = c.d / nz
  let i = 0
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      cb(c.x + (ix + 0.5) * w, c.z + (iz + 0.5) * d, w, d, i++)
    }
  }
}

function colorize(g: BufferGeometry, color: number): BufferGeometry {
  const n = g.getAttribute('position').count
  const c = new Float32Array(n * 3)
  const r = (((color >> 16) & 255) / 255) ** 2.2
  const gg = (((color >> 8) & 255) / 255) ** 2.2
  const b = ((color & 255) / 255) ** 2.2
  for (let i = 0; i < n; i++) {
    c[i * 3] = r
    c[i * 3 + 1] = gg
    c[i * 3 + 2] = b
  }
  g.setAttribute('color', new Float32BufferAttribute(c, 3))
  return g
}

/** A cylinder into the wood batch: `axis` is the direction of its length. */
function cyl(
  out: BufferGeometry[],
  r: number,
  len: number,
  seg: number,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z',
  color: number,
): void {
  const g = new CylinderGeometry(r, r, len, seg, 1, false).toNonIndexed()
  if (axis === 'x') {
    g.rotateZ(Math.PI / 2)
  } else if (axis === 'z') {
    g.rotateX(Math.PI / 2)
  }
  g.translate(x, y, z)
  out.push(colorize(g, color))
}

/** A spoked wagon wheel: rim, hub and four spokes, in the plane across `axis`. */
function wheel(
  b: DressBuilders,
  x: number,
  y: number,
  z: number,
  r: number,
  axleAlongX: boolean,
): void {
  cyl(b.extra, r, 0.08, 14, x, y, z, axleAlongX ? 'x' : 'z', DARK_WOOD)
  cyl(b.extra, r * 0.22, 0.16, 8, x, y, z, axleAlongX ? 'x' : 'z', IRON)
}

/** Box helper in rect-local terms: `a` along the long axis, `c` across it. */
function along(
  g: GeoBuilder,
  alongX: boolean,
  cx: number,
  cz: number,
  a: number,
  c: number,
  y: number,
  la: number,
  lc: number,
  h: number,
  color: number,
): void {
  if (alongX) {
    g.box(cx + a, y + h / 2, cz + c, la, h, lc, color)
  } else {
    g.box(cx + c, y + h / 2, cz + a, lc, h, la, color)
  }
}

/** Wagon chassis: bed, four wheels, tongue tucked inside the rect. Returns the bed's top. */
function chassis(
  b: DressBuilders,
  c: Rect,
  y: number,
  opts: { bed: number; wheelR: number; sides: number; color: number },
): number {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d)
  const W = Math.min(c.w, c.d)
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const bedLen = L - 1.1
  const bedW = W - 0.5
  const a0 = 0.45
  // the bed and its sides
  along(b.wood, alongX, cx, cz, a0, 0, y + opts.bed, bedLen, bedW, 0.12, opts.color)
  if (opts.sides > 0) {
    for (const s of [-1, 1]) {
      along(
        b.wood,
        alongX,
        cx,
        cz,
        a0,
        (s * (bedW - 0.06)) / 2,
        y + opts.bed + 0.12,
        bedLen,
        0.06,
        opts.sides,
        opts.color,
      )
    }
    for (const s of [-1, 1]) {
      along(
        b.wood,
        alongX,
        cx,
        cz,
        a0 + (s * (bedLen - 0.06)) / 2,
        0,
        y + opts.bed + 0.12,
        0.06,
        bedW,
        opts.sides,
        opts.color,
      )
    }
  }
  // axles and wheels, inside the rect's width
  const wr = opts.wheelR
  for (const a of [a0 - bedLen / 2 + wr + 0.1, a0 + bedLen / 2 - wr - 0.1]) {
    along(b.wood, alongX, cx, cz, a, 0, y + wr - 0.05, 0.1, W - 0.1, 0.1, IRON)
    for (const s of [-1, 1]) {
      const off = s * (W / 2 - 0.08)
      wheel(b, alongX ? cx + a : cx + off, y + wr, alongX ? cz + off : cz + a, wr, !alongX)
    }
  }
  // the tongue, angled down to the ground at the rect's end
  along(b.wood, alongX, cx, cz, a0 - bedLen / 2 - 0.5, 0, y + 0.35, 1.0, 0.1, 0.1, DARK_WOOD)
  along(b.wood, alongX, cx, cz, -L / 2 + 0.1, 0, y, 0.2, 0.5, 0.35, DARK_WOOD)
  return y + opts.bed + 0.12
}

/** A canvas bonnet over a bed: ribbed hoops and a half-barrel of canvas. */
function bonnet(b: DressBuilders, c: Rect, bedTop: number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d) - 1.3
  const W = Math.min(c.w, c.d) - 0.4
  const cx = c.x + c.w / 2 + (alongX ? 0.45 : 0)
  const cz = c.z + c.d / 2 + (alongX ? 0 : 0.45)
  const r = W / 2
  const segs = 8
  const V = (a: number, cc: number, y: number) =>
    alongX ? new Vector3(cx + a, y, cz + cc) : new Vector3(cx + cc, y, cz + a)
  const rise = 0.55
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI
    const t1 = ((i + 1) / segs) * Math.PI
    const c0 = Math.cos(t0) * r
    const c1 = Math.cos(t1) * r
    const y0 = bedTop + rise + Math.sin(t0) * r * 1.05
    const y1 = bedTop + rise + Math.sin(t1) * r * 1.05
    const yb0 = i === 0 ? bedTop : y0
    const yb1 = i === segs - 1 ? bedTop : y1
    const p0 = V(-L / 2, c0, yb0)
    const p1 = V(L / 2, c0, yb0)
    const p2 = V(L / 2, c1, yb1)
    const p3 = V(-L / 2, c1, yb1)
    if (alongX) {
      b.cloth.quad(p0, p1, p2, p3, CANVAS)
    } else {
      b.cloth.quad(p1, p0, p3, p2, CANVAS)
    }
    // the canvas gathered at the ends, a darker puckered ring
    for (const e of [-1, 1]) {
      const q0 = V((e * L) / 2, c0 * 0.55, bedTop + rise + Math.sin(t0) * r * 0.75)
      const q1 = V((e * L) / 2, c1 * 0.55, bedTop + rise + Math.sin(t1) * r * 0.75)
      const q2 = V((e * L) / 2, c1, yb1)
      const q3 = V((e * L) / 2, c0, yb0)
      const flip = e > 0 !== alongX
      if (flip) {
        b.cloth.quad(q3, q2, q1, q0, 0xd8_c8_a8)
      } else {
        b.cloth.quad(q0, q1, q2, q3, 0xd8_c8_a8)
      }
    }
  }
}

function stagecoach(b: DressBuilders, c: Rect, y: number, r: () => number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d)
  const W = Math.min(c.w, c.d)
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const body = r() < 0.5 ? 0x6a_22_1a : 0x2a_44_32
  const wr = 0.62
  // running gear
  for (const a of [-L / 2 + 0.95, L / 2 - 0.75]) {
    const rr = a < 0 ? wr * 0.85 : wr
    along(b.wood, alongX, cx, cz, a, 0, y + rr - 0.05, 0.1, W - 0.1, 0.1, IRON)
    for (const s of [-1, 1]) {
      const off = s * (W / 2 - 0.08)
      wheel(b, alongX ? cx + a : cx + off, y + rr, alongX ? cz + off : cz + a, rr, !alongX)
    }
  }
  // the body: a boxy coach on its thoroughbraces, painted, with darker panels and windows
  const bw = W - 0.45
  along(b.wall, alongX, cx, cz, 0.1, 0, y + 0.85, 2.5, bw, 1.5, body)
  along(b.wood, alongX, cx, cz, 0.1, 0, y + 2.35, 2.7, bw + 0.15, 0.1, DARK_WOOD)
  // roof rail and luggage
  along(b.wood, alongX, cx, cz, 0.1, 0, y + 2.45, 2.2, bw, 0.12, DARK_WOOD)
  along(b.wood, alongX, cx, cz, -0.2, 0, y + 2.57, 1.1, bw - 0.4, 0.38, 0x5a_3a_22)
  // windows, one each side
  for (const s of [-1, 1]) {
    along(b.wood, alongX, cx, cz, 0.1, s * (bw / 2 + 0.01), y + 1.55, 0.8, 0.02, 0.55, 0x1a_14_10)
  }
  // driver's box up front, and the boot at the back
  along(b.wood, alongX, cx, cz, -1.4, 0, y + 0.85, 0.6, bw, 1.2, DARK_WOOD)
  along(b.wood, alongX, cx, cz, -1.45, 0, y + 2.05, 0.5, bw, 0.12, DARK_WOOD)
  along(b.wood, alongX, cx, cz, 1.6, 0, y + 0.95, 0.55, bw - 0.1, 0.9, 0x3a_2a_1e)
  // tongue resting at the front
  along(b.wood, alongX, cx, cz, -L / 2 + 0.25, 0, y, 0.4, 0.5, 0.3, DARK_WOOD)
}

/** A stagecoach knocked onto its side: body lying across, wheels in the air. */
function wreck(b: DressBuilders, c: Rect, y: number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d)
  const W = Math.min(c.w, c.d)
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  // the body on its flank: 1.5 high becomes the width, 1.9 wide becomes the height
  along(b.wall, alongX, cx, cz, 0, -0.2, y, 2.6, 1.5, 1.85, 0x5a_22_1a)
  along(b.wood, alongX, cx, cz, 0, -0.2, y + 1.85, 2.8, 1.6, 0.1, 0x3a_2a_1e)
  // the undercarriage up the side, wheels sticking out flat
  along(b.wood, alongX, cx, cz, 0, 0.62, y + 0.35, 3.6, 0.12, 0.12, IRON)
  for (const a of [-1.35, 1.35]) {
    const off = 0.7
    const wx = alongX ? cx + a : cx + off
    const wz = alongX ? cz + off : cz + a
    cyl(b.extra, 0.6, 0.08, 14, wx, y + 0.95, wz, alongX ? 'z' : 'x', DARK_WOOD)
  }
  // a spilled trunk at each end
  along(b.wood, alongX, cx, cz, L / 2 - 0.45, 0, y, 0.7, W - 0.5, 0.5, 0x5a_3a_22)
  along(b.wood, alongX, cx, cz, -L / 2 + 0.55, -W / 2 + 0.55, y, 0.8, 0.5, 0.45, 0x5a_3a_22)
}

function boxcar(b: DressBuilders, c: Rect, y: number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d)
  const W = Math.min(c.w, c.d)
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  // trucks: two four-wheel bogies on the rails
  for (const a of [-L / 2 + 2, L / 2 - 2]) {
    along(b.wood, alongX, cx, cz, a, 0, y + 0.25, 2.2, 1.6, 0.5, IRON)
    for (const da of [-0.7, 0.7]) {
      for (const s of [-1, 1]) {
        const off = s * 0.72
        cyl(
          b.extra,
          0.42,
          0.1,
          12,
          alongX ? cx + a + da : cx + off,
          y + 0.42,
          alongX ? cz + off : cz + a + da,
          alongX ? 'z' : 'x',
          IRON,
        )
      }
    }
  }
  // frame, plank body (painted boards), roof with a walkway, sliding doors, end ladders
  along(b.wood, alongX, cx, cz, 0, 0, y + 0.85, L, W - 0.2, 0.3, 0x2a_22_1e)
  along(b.wall, alongX, cx, cz, 0, 0, y + 1.15, L - 0.2, W - 0.3, 2.45, 0x8a_32_24)
  along(b.wood, alongX, cx, cz, 0, 0, y + 3.6, L, W, 0.15, 0x4a_3a_30)
  along(b.wood, alongX, cx, cz, 0, 0, y + 3.75, L - 0.4, 0.5, 0.06, WEATHERED)
  for (const s of [-1, 1]) {
    along(
      b.wall,
      alongX,
      cx,
      cz,
      0.3,
      s * ((W - 0.3) / 2 + 0.04),
      y + 1.2,
      1.9,
      0.08,
      2.2,
      0x7a_2a_1e,
    )
    along(b.wood, alongX, cx, cz, 0.3, s * ((W - 0.3) / 2 + 0.07), y + 3.35, 2.5, 0.06, 0.08, IRON)
  }
  for (const e of [-1, 1]) {
    for (const s of [-0.3, 0.3]) {
      along(b.wood, alongX, cx, cz, e * (L / 2 - 0.06), s, y + 1.3, 0.04, 0.04, 2.2, IRON)
    }
    for (let k = 0; k < 6; k++) {
      along(
        b.wood,
        alongX,
        cx,
        cz,
        e * (L / 2 - 0.06),
        0,
        y + 1.5 + k * 0.38,
        0.04,
        0.6,
        0.04,
        IRON,
      )
    }
  }
}

function hitchRail(b: DressBuilders, c: Rect, y: number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d)
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const n = Math.max(2, Math.ceil(L / 2) + 1)
  for (let i = 0; i < n; i++) {
    const a = -L / 2 + 0.15 + ((L - 0.3) * i) / (n - 1)
    along(b.wood, alongX, cx, cz, a, 0, y, 0.14, 0.14, 0.98, DARK_WOOD)
  }
  along(b.wood, alongX, cx, cz, 0, 0, y + 0.92, L - 0.1, 0.12, 0.12, WEATHERED)
}

function trough(b: DressBuilders, c: Rect, y: number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d) - 0.1
  const W = Math.min(c.w, c.d) - 0.15
  // legs, plank sides and ends, water a hand below the rim
  for (const a of [-L / 2 + 0.2, L / 2 - 0.2]) {
    along(b.wood, alongX, cx, cz, a, 0, y, 0.12, W, 0.2, DARK_WOOD)
  }
  for (const s of [-1, 1]) {
    along(b.wood, alongX, cx, cz, 0, (s * (W - 0.08)) / 2, y + 0.2, L, 0.08, 0.5, 0x7a_5a_3e)
    along(b.wood, alongX, cx, cz, (s * (L - 0.08)) / 2, 0, y + 0.2, 0.08, W - 0.16, 0.5, 0x7a_5a_3e)
  }
  along(b.wood, alongX, cx, cz, 0, 0, y + 0.2, L - 0.16, W - 0.16, 0.06, 0x5a_44_30)
  along(b.wood, alongX, cx, cz, 0, 0, y + 0.58, L - 0.16, W - 0.16, 0.02, 0x3a_5a_60)
}

function lumber(b: DressBuilders, c: Rect, y: number, r: () => number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d) - 0.1
  const W = Math.min(c.w, c.d) - 0.1
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const boards = Math.max(3, Math.round(W / 0.26))
  const bw = W / boards
  let yy = y
  for (let layer = 0; layer < 5; layer++) {
    // stickers between layers
    for (const a of [-L / 2 + 0.4, 0, L / 2 - 0.4]) {
      along(b.wood, alongX, cx, cz, a, 0, yy, 0.08, W, 0.05, DARK_WOOD)
    }
    yy += 0.05
    for (let k = 0; k < boards; k++) {
      const len = L - r() * 0.3
      along(
        b.wood,
        alongX,
        cx,
        cz,
        (L - len) / 2 - r() * 0.05,
        -W / 2 + (k + 0.5) * bw,
        yy,
        len,
        bw - 0.02,
        0.13,
        0xc0_a0_78,
      )
    }
    yy += 0.13
  }
}

function woodpile(b: DressBuilders, c: Rect, y: number, r: () => number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d) - 0.1
  const W = Math.min(c.w, c.d) - 0.1
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const lr = 0.12
  // end posts hold the stack; logs lie across the rect, a few rows high, ends pale
  for (const e of [-1, 1]) {
    along(b.wood, alongX, cx, cz, (e * (L - 0.1)) / 2, 0, y, 0.1, 0.1, 1.0, DARK_WOOD)
  }
  const per = Math.floor((L - 0.25) / (lr * 2.05))
  for (let row = 0; row < 4; row++) {
    const n = per - (row % 2)
    for (let k = 0; k < n; k++) {
      const a = -L / 2 + 0.12 + lr + (row % 2) * lr + k * lr * 2.05
      const yy = y + lr + row * lr * 1.62
      const len = W - r() * 0.15
      const x = alongX ? cx + a : cx
      const z = alongX ? cz : cz + a
      cyl(b.extra, lr * (1 + r() * 0.06), len, 7, x, yy, z, alongX ? 'z' : 'x', 0x8a_64_44)
    }
  }
}

function well(b: DressBuilders, c: Rect, y: number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const s = Math.min(c.w, c.d) - 0.1
  const t = 0.28
  // fieldstone curb, a winch on two posts, a little shingled roof
  for (const [dx, dz, w, d] of [
    [0, -(s - t) / 2, s, t],
    [0, (s - t) / 2, s, t],
    [-(s - t) / 2, 0, t, s - 2 * t],
    [(s - t) / 2, 0, t, s - 2 * t],
  ] as const) {
    b.stone.box(cx + dx, y + 0.42, cz + dz, w, 0.84, d, 0xb8_b0_a0)
  }
  b.wood.box(cx, y + 0.04, cz, s - 2 * t, 0.02, s - 2 * t, 0x1a_20_22)
  for (const dx of [-(s / 2 - 0.12), s / 2 - 0.12]) {
    b.wood.box(cx + dx, y + 0.84 + 0.85, cz, 0.12, 1.7, 0.12, DARK_WOOD)
  }
  cyl(b.extra, 0.08, s - 0.3, 8, cx, y + 1.5, cz, 'x', WEATHERED)
  b.wood.gable(cx, y + 2.54, cz, s - 0.2, s - 0.4, 0.55, 'x', 0x6a_54_40, 0.1)
  b.wood.box(cx, y + 2.52, cz, s - 0.2, 0.06, s - 0.4, DARK_WOOD)
}

function buffer(b: DressBuilders, c: Rect, y: number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  // a timber buffer stop at the end of the line, a red-painted beam across it
  b.wood.box(cx, y + 0.4, cz, c.w - 0.1, 0.8, c.d - 0.3, 0x4a_3a_2c)
  b.wood.box(cx, y + 0.9, cz, c.w - 0.1, 0.2, c.d - 0.1, 0x9a_2a_1e)
}

function headstone(b: DressBuilders, c: Rect, y: number, r: () => number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  b.stone.box(cx, y + 0.06, cz, c.w - 0.04, 0.12, c.d - 0.04, 0x9a_94_88)
  if (r() < 0.35) {
    // a weathered wooden cross
    b.wood.box(cx, y + 0.5, cz, 0.09, 0.8, 0.09, WEATHERED)
    b.wood.box(cx, y + 0.68, cz, 0.42, 0.08, 0.09, WEATHERED)
  } else {
    b.stone.box(cx, y + 0.45, cz, 0.42, 0.7, 0.14, 0xb8_b2_a6)
  }
}

function counter(b: DressBuilders, c: Rect, y: number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  b.wood.box(cx, y + 0.52, cz, c.w - 0.04, 1.04, c.d - 0.04, 0x5a_3a_24)
  b.wood.box(cx, y + 1.07, cz, c.w + 0.06, 0.06, c.d + 0.06, 0x8a_5a_34)
}

function forge(b: DressBuilders, c: Rect, y: number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  // brick hearth, glowing coals, a chimney up through the roof, the bellows beside
  b.stone.box(cx, y + 0.45, cz, c.w - 0.1, 0.9, c.d - 0.1, 0x9a_5a_46)
  b.wood.box(cx, y + 0.92, cz, c.w - 0.6, 0.05, c.d - 0.6, 0x2a_1a_14)
  b.stone.box(cx - c.w / 2 + 0.5, y + 3.4, cz + c.d / 2 - 0.5, 0.9, 5.0, 0.9, 0x8a_50_40)
  b.wood.box(cx + c.w / 2 - 0.45, y + 1.0, cz - c.d / 2 + 0.45, 0.6, 0.18, 0.7, 0x4a_2e_1e)
}

function bridgeRail(b: DressBuilders, c: Rect, y: number): void {
  const alongX = c.w >= c.d
  const L = Math.max(c.w, c.d)
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const n = Math.max(2, Math.round(L / 1.6) + 1)
  for (let i = 0; i < n; i++) {
    const a = -L / 2 + 0.1 + ((L - 0.2) * i) / (n - 1)
    along(b.wood, alongX, cx, cz, a, 0, y, 0.16, 0.16, 1.0, DARK_WOOD)
  }
  along(b.wood, alongX, cx, cz, 0, 0, y + 0.9, L, 0.14, 0.12, WEATHERED)
  along(b.wood, alongX, cx, cz, 0, 0, y + 0.45, L, 0.08, 0.1, WEATHERED)
}

/** Porch roof posts (the porch roof itself is the building's). */
function post(b: DressBuilders, c: Rect, y: number, roof: number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  b.wood.box(cx, y + (roof - y) / 2, cz, 0.16, roof - y, 0.16, DARK_WOOD)
  b.wood.box(cx, y + 0.05, cz, 0.26, 0.1, 0.26, DARK_WOOD)
}

/** The rails between the buffer stops, ties under them. */
function track(layout: TownLayout, wood: GeoBuilder): void {
  const ends = layout.cover.filter((c) => c.kind === 'buffer')
  if (ends.length < 2) {
    return
  }
  const xs = ends.map((c) => c.x + c.w / 2)
  const z = (ends[0]?.z ?? 0) + (ends[0]?.d ?? 0) / 2
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  for (let x = x0 + 0.6; x < x1 - 0.3; x += 0.9) {
    wood.box(x, 0.04, z, 0.25, 0.08, 2.3, 0x4a_3a_2c)
  }
  for (const off of [-0.72, 0.72]) {
    wood.box((x0 + x1) / 2, 0.14, z + off, x1 - x0, 0.12, 0.08, 0x6a_66_62)
  }
}

export function dressCover(
  layout: TownLayout,
  props: GLTF,
  parent: Object3D,
  b: DressBuilders,
  floorAt: (x: number, z: number) => number,
  porchRoof: number,
): void {
  const r = rand(0x70_57)
  const p: Placed = new Map()
  const unit = (name: string) => propDef(props, name, 1, UNIT[name] ?? 'max')
  for (const c of layout.cover) {
    place(c, p, b, r, unit, floorAt(c.x + c.w / 2, c.z + c.d / 2), porchRoof)
  }
  track(layout, b.wood)
  const land = outskirtsProps(layout, OUTSKIRTS_SEED)
  const sized = (name: string, size: number, axis: 'max' | 'y' | 'x', mats: Matrix4[]) => {
    if (mats.length === 0) {
      return
    }
    const def = propDef(props, name, size, axis)
    if (def) {
      instance(def, mats, parent, false)
    }
  }
  sized('rock', 1.2, 'max', land.rock)
  // the cactus spots grow procedural saguaros and Joshua trees instead (wilds.ts)
  // the boundary fence is the kit fence at its own 2 m section size
  for (const m of land.fence) {
    put(p, 'fence@edge', m)
  }
  for (const [key, mats] of p) {
    const [name = '', variant] = key.split('@')
    const def = variant === 'edge' ? propDef(props, name, 2, 'x') : unit(name)
    if (def && mats.length > 0) {
      // static and low: their shadows are in the baked ground mask, not the real-time map
      for (const m of instance(def, mats, parent, false)) {
        // the boundary fence is its own batch (the audits key instances by name)
        m.name = variant ? `${name}_${variant}` : name
      }
    }
  }
}

function place(
  c: Cover,
  p: Placed,
  b: DressBuilders,
  r: () => number,
  unit: (name: string) => PropDef | null,
  y: number,
  porchRoof: number,
): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const alongX = c.w >= c.d
  const kit = (name: string, cb: (def: PropDef) => void) => {
    const def = unit(name)
    if (def) {
      cb(def)
    }
  }
  switch (c.kind) {
    case 'barrels':
      kit('barrel', (def) =>
        cells(c, 0.75, (x, z, w, d) =>
          put(
            p,
            'barrel',
            fitTo(def, x, y, z, Math.min(w, d) - 0.06, Math.min(w, d) - 0.06, 0.95, r() * 6),
          ),
        ),
      )
      break
    case 'crates':
      kit('crate', (def) =>
        cells(c, 0.75, (x, z, w, d) =>
          put(p, 'crate', fitTo(def, x, y, z, w - 0.04, d - 0.04, 0.72, (r() - 0.5) * 0.06)),
        ),
      )
      break
    case 'crate_stack':
      kit('crate', (def) =>
        cells(c, 0.75, (x, z, w, d, i) => {
          put(p, 'crate', fitTo(def, x, y, z, w - 0.04, d - 0.04, 0.72, (r() - 0.5) * 0.06))
          put(p, 'crate', fitTo(def, x, y + 0.72, z, w - 0.06, d - 0.06, 0.72, (r() - 0.5) * 0.1))
          if (i === 0) {
            put(p, 'crate', fitTo(def, cx, y + 1.44, cz, w - 0.08, d - 0.08, 0.72, 0.2))
          }
        }),
      )
      break
    case 'hay':
      kit('hay', (def) =>
        cells(c, 1, (x, z, w, d) => put(p, 'hay', fitTo(def, x, y, z, w - 0.04, d - 0.04, 0.95))),
      )
      break
    case 'fence':
      kit('fence', (def) => {
        const L = Math.max(c.w, c.d)
        const n = Math.max(1, Math.round(L / 2.2))
        const seg = L / n
        for (let i = 0; i < n; i++) {
          const t = -L / 2 + (i + 0.5) * seg
          const x = alongX ? cx + t : cx
          const z = alongX ? cz : cz + t
          put(p, 'fence', fitTo(def, x, y, z, alongX ? seg : 0.3, alongX ? 0.3 : seg, 1.1))
        }
      })
      break
    case 'bench':
      kit('k_bench', (def) => put(p, 'k_bench', fitTo(def, cx, y, cz, c.w - 0.06, c.d - 0.06, 0.5)))
      break
    case 'table':
      kit('k_table', (def) => put(p, 'k_table', fitTo(def, cx, y, cz, c.w * 0.54, c.d * 0.54, 0.8)))
      kit('k_chair', (def) => {
        for (const s of [-1, 1]) {
          put(
            p,
            'k_chair',
            fitTo(
              def,
              cx + s * c.w * 0.4,
              y,
              cz,
              0.28,
              0.4,
              0.9,
              s > 0 ? Math.PI / 2 : -Math.PI / 2,
            ),
          )
        }
      })
      break
    case 'anvil':
      cyl(b.extra, 0.24, 0.45, 9, cx, y + 0.225, cz, 'y', 0x6a_4a_32)
      kit('k_anvil', (def) =>
        put(p, 'k_anvil', fitTo(def, cx, y + 0.45, cz, c.w - 0.2, c.d - 0.1, 0.35)),
      )
      break
    case 'coffins':
      kit('coffin', (def) => {
        put(p, 'coffin', fitTo(def, cx, y, cz, c.w - 0.1, c.d - 0.1, 0.45))
        put(p, 'coffin', fitTo(def, cx, y + 0.37, cz, c.w - 0.2, c.d - 0.15, 0.42, 0.04))
      })
      break
    case 'wagon': {
      const top = chassis(b, c, y, { bed: 0.75, wheelR: 0.5, sides: 0.35, color: 0x8a_62_40 })
      // a couple of sacks and a crate in the bed
      kit('k_sack', (def) => put(p, 'k_sack', fitTo(def, cx, top, cz, 0.6, 0.45, 0.4, r())))
      break
    }
    case 'covered_wagon': {
      const top = chassis(b, c, y, { bed: 0.85, wheelR: 0.6, sides: 0.4, color: 0x7a_58_3a })
      bonnet(b, c, top)
      break
    }
    case 'freight_wagon': {
      const top = chassis(b, c, y, { bed: 0.8, wheelR: 0.55, sides: 0.25, color: 0x6a_4a_32 })
      // lashed crates two high along the bed
      kit('crate', (def) => {
        const L = Math.max(c.w, c.d) - 1.5
        const n = Math.max(1, Math.floor(L / 0.75))
        for (let k = 0; k < n; k++) {
          const a = 0.45 - L / 2 + (k + 0.5) * (L / n)
          for (const s of [-0.33, 0.33]) {
            const x = alongX ? cx + a : cx + s
            const z = alongX ? cz + s : cz + a
            put(p, 'crate', fitTo(def, x, top + 0.01, z, 0.6, 0.6, 0.62, (r() - 0.5) * 0.1))
            if ((k + (s > 0 ? 1 : 0)) % 3 !== 2) {
              put(p, 'crate', fitTo(def, x, top + 0.64, z, 0.56, 0.56, 0.58, (r() - 0.5) * 0.12))
            }
          }
        }
      })
      break
    }
    case 'stagecoach':
      stagecoach(b, c, y, r)
      break
    case 'wreck':
      wreck(b, c, y)
      break
    case 'trough':
      trough(b, c, y)
      break
    case 'hitch_rail':
      hitchRail(b, c, y)
      break
    case 'boxcar':
      boxcar(b, c, y)
      break
    case 'lumber':
      lumber(b, c, y, r)
      break
    case 'woodpile':
      woodpile(b, c, y, r)
      break
    case 'well':
      well(b, c, y)
      kit('k_bucket', (def) =>
        put(p, 'k_bucket', fitTo(def, cx, y + 0.84, cz + (c.d - 0.1) / 2 - 0.14, 0.24, 0.24, 0.26)),
      )
      break
    case 'buffer':
      buffer(b, c, y)
      break
    case 'headstone':
      headstone(b, c, y, r)
      break
    case 'counter':
      counter(b, c, y)
      break
    case 'forge':
      forge(b, c, y)
      break
    case 'bridge_rail':
      bridgeRail(b, c, y)
      break
    case 'post':
      post(b, c, y, porchRoof)
      break
    default:
      break
  }
}
