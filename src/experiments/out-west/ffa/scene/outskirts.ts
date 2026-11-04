// biome-ignore-all lint/complexity/useMaxParams: noise and placement helpers take positional numeric args
// biome-ignore-all lint/style/noMagicNumbers: terrain shaping constants, tuned by eye against the top-down camera
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the grid and scatter passes are flat loops with placement rules inline
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one module for the land past the edge: heights, grid, scatter, bushes and stones share the noise
/**
 * Perdition's outskirts: the land past the playable square, so the top-down camera never shows a
 * flat band at the edge of the world, at any aspect.
 *
 * - North of the creek a cut bank climbs to a scrubby bench (a ragged, gullied lip, a notch where
 *   the north road climbs out over the bridge), with hills and mesas rising behind it.
 * - West, east and south, open desert rolls away from a ranch fence and rises into hills and mesas;
 *   the creek bed runs out through a gap in them.
 * - Sage bushes are built into the terrain geometry (the ground material, no extra draw).
 * - Rocks, cacti and the boundary fence are placed here for `dressing.ts` to instance, in seeded
 *   clusters (never grids or rows).
 *
 * Everything is deterministic: the same town for every player. The terrain is sunk a little, so
 * where it is flat the ground plane covers it and only the relief shows (no z-fighting).
 */
import { BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three'
import type { TownLayout } from '../sim/layout.ts'
import { hash32, Rng } from '../sim/rng.ts'

/** The one seed for the outskirts' terrain and scatter (the same land for every player). */
export const OUTSKIRTS_SEED = 0x0f_ee_15

/** How far below the ground plane flat terrain sits. */
const SINK = 0.15
/** How far past the playable square the terrain and the scatter reach (the camera sees ~30 m). */
const REACH = 34
/** Ground texture metres per repeat (the ground plane's tiling). */
const TILE = 5

const lattice = (ix: number, iz: number, seed: number): number =>
  hash32(ix | 0, iz | 0, seed) / 4_294_967_296

const fade = (t: number): number => t * t * (3 - 2 * t)

/** Value noise in [0, 1). */
function noise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = fade(x - ix)
  const fz = fade(z - iz)
  const a = lattice(ix, iz, seed)
  const b = lattice(ix + 1, iz, seed)
  const c = lattice(ix, iz + 1, seed)
  const d = lattice(ix + 1, iz + 1, seed)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

function fbm(x: number, z: number, seed: number): number {
  return (
    noise(x, z, seed) * 0.55 +
    noise(x * 2.1, z * 2.1, seed + 1) * 0.3 +
    noise(x * 4.3, z * 4.3, seed + 2) * 0.15
  )
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (e0: number, e1: number, v: number): number => fade(clamp01((v - e0) / (e1 - e0)))

/** Mesa tops: flat plateaus with a talus skirt, where a slow noise field runs high. */
function mesa(x: number, z: number): number {
  const m = fbm(x * 0.021 + 40, z * 0.021 - 17, 17)
  const top = 8.5 + 3.5 * noise(x * 0.04, z * 0.04, 18)
  return top * smooth(0.6, 0.635, m) + 2.2 * smooth(0.5, 0.6, m)
}

/** The toe of the creek's north cut bank (the edge of the creek bed), z in metres. */
function bankToe(x: number): number {
  return 3.3 - 0.35 * noise(x * 0.21, 0, 11)
}

function northHeight(layout: TownLayout, x: number, z: number): number {
  const toe = bankToe(x)
  if (z >= toe) {
    return 0
  }
  const face = 1.5 + 1.6 * noise(x * 0.13, 5, 12)
  const bench = 4.2 + 1.2 * fbm(x * 0.05, z * 0.05, 13)
  const t = clamp01((toe - z) / face)
  // a talus ramp at the foot, then the cut face, then the bench
  let h = bench * (0.18 * Math.min(1, t * 3) + 0.82 * smooth(0.28, 0.95, t))
  // gullies bite into the lip
  const gully = smooth(0.66, 0.84, noise(x * 0.33, 3, 14))
  h *= 1 - 0.4 * gully * (1 - clamp01((toe - face - z) / 7))
  // the north road climbs out of the creek through a notch over the bridge
  const br = layout.creek.bridge
  const roadX = br.x + br.w / 2
  const notch = 1 - smooth(br.w / 2 + 1, br.w / 2 + 6, Math.abs(x - roadX))
  const ramp = bench * clamp01((toe - z) / 30)
  h += (Math.min(h, ramp) - h) * notch
  // hills and mesas behind the bench
  const behind = smooth(-6, -22, z)
  h += behind * (1.5 + 6.5 * fbm(x * 0.03, z * 0.03, 15)) + mesa(x, z) * smooth(-9, -22, z)
  // bumps on the bench, so its top is never one plane
  h += 0.35 * (fbm(x * 0.22, z * 0.22, 19) - 0.5) * smooth(0, 1, t)
  return h
}

function ringHeight(layout: TownLayout, x: number, z: number): number {
  const s = layout.size
  const dx = Math.max(-x, x - s, 0)
  const dz = Math.max(z - s, 0)
  const d = Math.hypot(dx, dz)
  if (d <= 0) {
    return 0
  }
  const c = layout.creek
  // the creek bed runs out east and west through a gap in the hills
  const mid = c.z + c.d / 2
  const valley = smooth(c.d / 2 + 1, c.d / 2 + 10, Math.abs(z - mid))
  const southSoft = z > s ? 0.75 : 1
  // close in: the camera sees ~15-20 m past the west, east and south edges
  // rolling: knolls and swales at a few metres' spacing, so light and shade alternate in view
  const roll = fbm(x * 0.11, z * 0.11, 25)
  const hills =
    smooth(2.5, 13, d) * (0.8 + 5 * fbm(x * 0.045, z * 0.045, 16) + 3.2 * roll) * southSoft
  const dunes = 0.5 * fbm(x * 0.18, z * 0.18, 20) * smooth(1.5, 5, d)
  // rocky outcrops: small buttes with cut sides, close enough to the fence to be seen
  const butte = 2.6 * smooth(0.6, 0.67, noise(x * 0.085, z * 0.085, 24)) * smooth(4, 9, d)
  return (hills + mesa(x, z) * smooth(6, 15, d) * southSoft + dunes + butte) * valley
}

/**
 * Terrain height at (x, z), m: 0 inside the town; never inside the playable square's walkable
 * ground. (The creek's south bank used to carry a dirt berm here, a 0.4 m mound with no reason to
 * be there at eye level; the bank is a rail fence in the layout now.)
 */
export function terrainHeight(layout: TownLayout, x: number, z: number): number {
  return Math.max(northHeight(layout, x, z), ringHeight(layout, x, z))
}

/** Rows of the terrain grid: fine across the creek's cut bank, coarse elsewhere. */
function rows(layout: TownLayout): number[] {
  const out: number[] = []
  for (let z = -REACH; z < -4; z += 2.5) {
    out.push(z)
  }
  for (let z = -4; z < 4.5; z += 0.5) {
    out.push(z)
  }
  const bank = layout.creek.z + layout.creek.d
  for (let z = 6; z < bank - 1.5; z += 2.5) {
    out.push(z)
  }
  // fine across the berm on the south bank
  for (let z = bank - 1.5; z < bank + 2; z += 0.25) {
    out.push(z)
  }
  for (let z = bank + 2; z <= layout.size + REACH; z += 2.5) {
    out.push(z)
  }
  return out
}

/** Sandstone strata on steep faces, paler on mesa tops; flat ground keeps the dirt's own colour. */
function terrainColor(y: number, ny: number, x: number, z: number, out: number[]): void {
  const steep = smooth(0.97, 0.72, ny)
  const band = 0.5 + 0.5 * Math.sin(y * 2.6 + 1.8 * noise(x * 0.08, z * 0.08, 21))
  // red and cream strata, darker in the shade at the foot of a face
  const foot = 1 - 0.18 * (1 - smooth(0.1, 0.9, y))
  // (multipliers on the orange dirt: cream needs a lot more green and blue)
  const r = (1.0 + 0.28 * band) * foot
  const g = (0.78 + 0.72 * band) * foot
  const b = (0.7 + 1.3 * band) * foot
  // flats out of town: patches of darker scrub soil and pale hardpan
  const patch = noise(x * 0.09, z * 0.09, 23)
  const flat = 1 - steep
  const fr = 1 + flat * (patch > 0.55 ? -0.1 : 0.05) * smooth(0.2, 1.2, y)
  const fg = 1 + flat * (patch > 0.55 ? -0.06 : 0.04) * smooth(0.2, 1.2, y)
  const fb = 1 + flat * (patch > 0.55 ? -0.16 : 0.02) * smooth(0.2, 1.2, y)
  // up on the bench and the hills: paler, straw-dry hardpan (reads apart from the creek bed)
  const up = smooth(1.2, 3.2, y) * flat
  const hr = 1 + 0.12 * up
  const hg = 1 + 0.3 * up
  const hb = 1 + 0.5 * up
  out.push(
    (1 + (r - 1) * steep) * fr * hr,
    (1 + (g - 1) * steep) * fg * hg,
    (1 + (b - 1) * steep) * fb * hb,
  )
}

interface Mesh3 {
  pos: number[]
  nor: number[]
  uv: number[]
  col: number[]
  idx: number[]
}

function terrainGrid(layout: TownLayout, m: Mesh3, sun: Vector3): void {
  const s = layout.size
  const xs: number[] = []
  for (let x = -REACH; x <= s + REACH; x += 2.5) {
    xs.push(x)
  }
  const zs = rows(layout)
  const nx = xs.length
  const h: number[] = []
  for (const z of zs) {
    for (const x of xs) {
      h.push(terrainHeight(layout, x, z) - SINK)
    }
  }
  const at = (i: number, j: number) => h[j * nx + i] ?? -SINK
  // only the vertices of cells that show (the flat ones sit under the ground plane)
  const used = new Int32Array(h.length).fill(-1)
  const cells: number[] = []
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      if (Math.max(h[a] ?? 0, h[a + 1] ?? 0, h[a + nx] ?? 0, h[a + nx + 1] ?? 0) >= -0.05) {
        cells.push(a)
        for (const v of [a, a + 1, a + nx, a + nx + 1]) {
          used[v] = 0
        }
      }
    }
  }
  const n = new Vector3()
  for (const [j, z] of zs.entries()) {
    for (const [i, x] of xs.entries()) {
      if (used[j * nx + i] === -1) {
        continue
      }
      used[j * nx + i] = m.pos.length / 3
      const y = at(i, j)
      // central differences over the uneven grid
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(nx - 1, i + 1)
      const j0 = Math.max(0, j - 1)
      const j1 = Math.min(zs.length - 1, j + 1)
      const ddx = (at(i1, j) - at(i0, j)) / ((xs[i1] ?? 0) - (xs[i0] ?? 0) || 1)
      const ddz = (at(i, j1) - at(i, j0)) / ((zs[j1] ?? 0) - (zs[j0] ?? 0) || 1)
      n.set(-ddx, 1, -ddz).normalize()
      m.pos.push(x, y, z)
      m.nor.push(n.x, n.y, n.z)
      // the ground's own projection (its shader blends in side projections on the cliffs)
      m.uv.push(x / TILE, -z / TILE)
      terrainColor(y, n.y, x, z, m.col)
      // baked, exaggerated hill shading (a cartographer's hillshade): seen from straight above, a
      // 3 m rise under real light alone barely changes tone
      const k = m.col.length - 3
      const lit = Math.min(1.3, Math.max(0.65, 1 + 1.2 * (n.dot(sun) - sun.y)))
      // fade it in off the ground plane, so there's no seam where the land rises out of it
      const shade = 1 + (lit - 1) * smooth(0, 0.8, y)
      m.col[k] = (m.col[k] ?? 1) * shade
      m.col[k + 1] = (m.col[k + 1] ?? 1) * shade
      m.col[k + 2] = (m.col[k + 2] ?? 1) * shade
    }
  }
  for (const a of cells) {
    const [va, vb, vc, vd] = [used[a], used[a + 1], used[a + nx], used[a + nx + 1]] as number[]
    m.idx.push(va ?? 0, vc ?? 0, vb ?? 0, vb ?? 0, vc ?? 0, vd ?? 0)
  }
}

// --- Clustered scatter -------------------------------------------------------------------------

export interface Scatter {
  x: number
  z: number
  /** Size multiplier. */
  s: number
}

/**
 * Clumps, not rows: cluster centres by dart throwing (a minimum spacing, so clumps don't merge),
 * then a few members around each, scattered tighter for the bigger ones.
 */
function clumps(
  rng: Rng,
  opts: {
    count: number
    minSep: number
    members: [number, number]
    spread: number
    size: [number, number]
    sample: () => { x: number; z: number }
    ok: (x: number, z: number) => boolean
  },
): Scatter[] {
  const centres: { x: number; z: number }[] = []
  for (let tries = 0; centres.length < opts.count && tries < opts.count * 30; tries++) {
    const c = opts.sample()
    if (!opts.ok(c.x, c.z)) {
      continue
    }
    if (centres.some((o) => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < opts.minSep ** 2)) {
      continue
    }
    centres.push(c)
  }
  const out: Scatter[] = []
  for (const c of centres) {
    const n = rng.int(opts.members[0], opts.members[1])
    const lead = rng.range(opts.size[0], opts.size[1])
    for (let k = 0; k < n; k++) {
      const s = k === 0 ? lead : lead * rng.range(0.3, 0.75)
      const a = rng.next() * Math.PI * 2
      // members fall off from the lead stone, gaussian-ish
      const r = k === 0 ? 0 : opts.spread * (0.35 + rng.next() + rng.next()) * 0.6 + lead * 0.4
      const x = c.x + Math.cos(a) * r
      const z = c.z + Math.sin(a) * r
      if (opts.ok(x, z)) {
        out.push({ x, z, s })
      }
    }
  }
  return out
}

export interface OutskirtsProps {
  rock: Matrix4[]
  cactus: Matrix4[]
  fence: Matrix4[]
}

/** Slope of the terrain at (x, z) (rise over run). */
function slope(layout: TownLayout, x: number, z: number): number {
  const e = 0.6
  const dx = terrainHeight(layout, x + e, z) - terrainHeight(layout, x - e, z)
  const dz = terrainHeight(layout, x, z + e) - terrainHeight(layout, x, z - e)
  return Math.hypot(dx, dz) / (2 * e)
}

function matrix(
  x: number,
  y: number,
  z: number,
  ry: number,
  sx: number,
  sy: number,
  sz: number,
  tilt = 0,
): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry)
  if (tilt !== 0) {
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt))
  }
  return new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz))
}

/** A point out past the playable edge, mostly close to it (where the camera can see). */
function nearEdge(rng: Rng, layout: TownLayout, maxOut: number): { x: number; z: number } {
  const s = layout.size
  const out = 0.6 + maxOut * rng.next() ** 2.2
  const along = rng.range(-maxOut, s + maxOut)
  switch (rng.int(0, 3)) {
    case 0:
      return { x: -out, z: along }
    case 1:
      return { x: s + out, z: along }
    case 2:
      return { x: along, z: s + out }
    default:
      return { x: along, z: bankToe(along) - out }
  }
}

/** Outside the playable square, or on its unwalkable north strip. */
function outside(layout: TownLayout, x: number, z: number, margin: number): boolean {
  const s = layout.size
  return x < -margin || x > s + margin || z > s + margin || z < bankToe(x) - margin
}

/**
 * Rocks (a rocky ridge on the creek's north lip, talus under hills, clumps in the open), cacti, a
 * ranch fence round the west, east and south edges, and pebbles in the creek bed.
 */
export function outskirtsProps(layout: TownLayout, seed: number): OutskirtsProps {
  const rng = new Rng(seed)
  const s = layout.size
  const c = layout.creek
  const out: OutskirtsProps = { rock: [], cactus: [], fence: [] }
  const anywhere = () => nearEdge(rng, layout, REACH - 10)
  // the drawn surface: the terrain mesh sits SINK under the analytic height, the ground plane at 0
  const y = (x: number, z: number) => Math.max(0, terrainHeight(layout, x, z) - SINK) - 0.05
  const rock = (p: Scatter) =>
    out.rock.push(
      matrix(
        p.x,
        y(p.x, p.z) - p.s * (0.12 + 0.35 * Math.min(1, slope(layout, p.x, p.z))),
        p.z,
        rng.next() * 6.3,
        p.s,
        p.s * rng.range(0.7, 1.1),
        p.s,
        (rng.next() - 0.5) * 0.4,
      ),
    )
  // The rocky ridge: boulders strung irregularly along the bench's lip, and outside the fence on
  // the other three sides.
  const br = c.bridge
  for (const p of clumps(rng, {
    count: 34,
    minSep: 8,
    members: [1, 3],
    spread: 1.6,
    size: [1.0, 2.0],
    sample: () => {
      const along = rng.range(-26, s + 26)
      const dist = rng.range(1.8, 5)
      switch (rng.int(0, 3)) {
        case 0:
          return { x: -dist, z: along }
        case 1:
          return { x: s + dist, z: along }
        case 2:
          return { x: along, z: s + dist }
        default:
          return { x: along, z: bankToe(along) - dist - 0.8 }
      }
    },
    ok: (x, z) =>
      outside(layout, x, z, 1.2) &&
      // up on the bench past its lip, never on the cut face itself
      !(z < c.z + 1 && z > bankToe(x) - 1.1) &&
      Math.abs(x - (br.x + br.w / 2)) > br.w / 2 + 2.5 &&
      // keep the trails out of town clear
      !(Math.abs(z - 64) < 8 && (x < 0 || x > s)) &&
      !(Math.abs(x - 72) < 6 && z > s),
  })) {
    rock(p)
  }
  // Talus and clumps out in the open, never on a cliff face.
  for (const p of clumps(rng, {
    count: 8,
    minSep: 12,
    members: [1, 2],
    spread: 1.4,
    size: [0.6, 1.5],
    sample: anywhere,
    ok: (x, z) => outside(layout, x, z, 2.5) && slope(layout, x, z) < 0.55,
  })) {
    rock(p)
  }
  // Stones fallen from the cut bank, lying at its toe: on the unwalkable north strip only (on the
  // walkable bed and the south bank they were knee-high blobs with no collider).
  for (const p of clumps(rng, {
    count: 10,
    minSep: 10,
    members: [2, 3],
    spread: 0.5,
    size: [0.32, 0.55],
    sample: () => {
      const x = rng.range(c.x + 2, c.x + c.w - 2)
      return { x, z: Math.min(c.z - 0.5, bankToe(x)) - rng.range(0.2, 0.8) }
    },
    ok: (x, z) => z < c.z - 0.3 && (x < c.bridge.x - 1 || x > c.bridge.x + c.bridge.w + 1),
  })) {
    rock(p)
  }
  // Cacti: singles and pairs, out in the open.
  for (const p of clumps(rng, {
    count: 26,
    minSep: 9,
    members: [1, 2],
    spread: 1.8,
    size: [0.75, 1.5],
    sample: anywhere,
    ok: (x, z) => outside(layout, x, z, 3) && slope(layout, x, z) < 0.35,
  })) {
    out.cactus.push(
      matrix(
        p.x,
        y(p.x, p.z) - 0.2 * p.s * slope(layout, p.x, p.z),
        p.z,
        rng.next() * 6.3,
        p.s,
        p.s,
        p.s,
        (rng.next() - 0.5) * 0.12,
      ),
    )
  }
  // The ranch fence on the boundary (west, east, south), sections a little askew, a few down or
  // missing, and open where the streets run out of town as trails.
  const Section = 3
  const gaps = (along: number, side: 'w' | 'e' | 's') =>
    side === 's' ? Math.abs(along - 72) < 5.5 : Math.abs(along - 64) < 7
  for (const side of ['w', 'e', 's'] as const) {
    for (let a = 2; a + Section / 2 < s - 1; a += Section) {
      const mid = a + Section / 2
      if (gaps(mid, side) || rng.next() < 0.07) {
        continue
      }
      const jitter = (rng.next() - 0.5) * 0.25
      const edgeX = side === 'w' ? 0.25 : s - 0.25
      const x = side === 's' ? mid : edgeX + jitter
      const z = side === 's' ? s - 0.25 + jitter : mid
      const ry = (side === 's' ? 0 : Math.PI / 2) + (rng.next() - 0.5) * 0.08
      const down = rng.next() < 0.06
      out.fence.push(
        matrix(
          x,
          0,
          z,
          ry,
          Section / 2,
          down ? 1.2 : 2.6 + rng.next() * 0.4,
          1.4,
          down ? 1.25 : (rng.next() - 0.5) * 0.1,
        ),
      )
    }
  }
  return out
}

// --- Sage bushes, built into the terrain ---------------------------------------------------------

/** Multipliers on the orange dirt that land on sage greens and grey-greens. */
const SAGE = [
  [0.72, 1.6, 2.3],
  [0.8, 1.55, 1.9],
  [0.6, 1.35, 1.75],
  [0.9, 1.75, 2.6],
] as const

/**
 * A sage bush: two or three low, round lobes (five-sided cones with soft, domed normals), dirt
 * textured and tinted grey-green, paler on top.
 */
function bush(
  m: Mesh3,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  r: number,
  ground: (x: number, z: number) => number,
): void {
  const col = SAGE[rng.int(0, SAGE.length - 1)] ?? SAGE[0]
  const lobes = rng.int(2, 3)
  const n = new Vector3()
  const put = (p: Vector3, nn: Vector3, shade: number) => {
    m.idx.push(m.pos.length / 3)
    m.pos.push(p.x, p.y, p.z)
    m.nor.push(nn.x, nn.y, nn.z)
    m.uv.push(p.x / TILE, -p.z / TILE)
    m.col.push(col[0] * shade, col[1] * shade, col[2] * shade)
  }
  for (let l = 0; l < lobes; l++) {
    const a0 = rng.next() * Math.PI * 2
    const off = l === 0 ? 0 : r * rng.range(0.35, 0.6)
    const lx = x + Math.cos(a0) * off
    const lz = z + Math.sin(a0) * off
    const lr = r * (l === 0 ? 1 : rng.range(0.55, 0.8))
    const top = new Vector3(lx, y + lr * rng.range(0.8, 1.05), lz)
    const ring: Vector3[] = []
    const rot = rng.next() * Math.PI
    for (let i = 0; i < 5; i++) {
      const a = rot + (i / 5) * Math.PI * 2
      const rr = lr * rng.range(0.8, 1.1)
      const vx = lx + Math.cos(a) * rr
      const vz = lz + Math.sin(a) * rr
      // each lobe's skirt follows the slope under it (on a hillside the downhill edge floated)
      ring.push(new Vector3(vx, Math.min(y, ground(vx, vz)) - 0.04, vz))
    }
    const up = new Vector3(0, 1, 0)
    for (let i = 0; i < 5; i++) {
      const p = ring[i] as Vector3
      const q = ring[(i + 1) % 5] as Vector3
      put(top, up, 1.2)
      for (const v of [q, p]) {
        n.set(v.x - lx, 0, v.z - lz)
          .normalize()
          .multiplyScalar(0.9)
        n.y = 0.55
        put(v, n.normalize(), 0.78)
      }
    }
  }
}

/** Multipliers on the orange dirt that land on greys, pale and dark. */
const STONE = [
  [1.15, 2.0, 3.6],
  [0.95, 1.65, 3.0],
  [0.7, 1.15, 2.0],
  [1.35, 2.2, 3.4],
] as const

/** A flat, faceted stone (a low pentagonal pyramid), dirt-textured and greyed. */
function stone(m: Mesh3, rng: Rng, x: number, z: number, r: number, y = 0, maxH = 9): void {
  const k = 5
  const rot = rng.next() * Math.PI
  const ring: Vector3[] = []
  for (let i = 0; i < k; i++) {
    const a = rot + (i / k) * Math.PI * 2
    const rr = r * rng.range(0.6, 1.2)
    ring.push(new Vector3(x + Math.cos(a) * rr, y + 0.01, z + Math.sin(a) * rr * 0.75))
  }
  const top = new Vector3(x, y + Math.min(maxH, r * rng.range(0.35, 0.6)), z)
  const col = STONE[rng.int(0, STONE.length - 1)] ?? STONE[0]
  const e1 = new Vector3()
  const e2 = new Vector3()
  for (let i = 0; i < k; i++) {
    const p = ring[i] as Vector3
    const q = ring[(i + 1) % k] as Vector3
    const n = e1.subVectors(q, top).cross(e2.subVectors(p, top)).normalize()
    if (n.y < 0) {
      n.negate()
    }
    for (const v of [top, q, p]) {
      m.idx.push(m.pos.length / 3)
      m.pos.push(v.x, v.y, v.z)
      m.nor.push(n.x, n.y, n.z)
      m.uv.push(v.x / TILE + 0.37, -v.z / TILE)
      m.col.push(col[0], col[1], col[2])
    }
  }
}

/** The outskirts terrain plus its sage bushes: one geometry, drawn with the ground's material. */
export function outskirtsGeometry(layout: TownLayout, seed: number, sun: Vector3): BufferGeometry {
  const m: Mesh3 = { pos: [], nor: [], uv: [], col: [], idx: [] }
  terrainGrid(layout, m, sun.clone().normalize())
  const rng = new Rng(seed ^ 0x5a_6e)
  const c = layout.creek
  const place = (p: Scatter) => {
    const y = Math.max(0, terrainHeight(layout, p.x, p.z) - SINK)
    bush(m, rng, p.x, y, p.z, 0.45 * p.s, (gx, gz) =>
      Math.max(0, terrainHeight(layout, gx, gz) - SINK),
    )
  }
  // Scrub out on the flats and the bench.
  for (const p of clumps(rng, {
    count: 230,
    minSep: 3.5,
    members: [3, 7],
    spread: 1.6,
    size: [0.8, 1.6],
    sample: () => nearEdge(rng, layout, REACH - 6),
    ok: (x, z) => outside(layout, x, z, 1.2) && slope(layout, x, z) < 0.5,
  })) {
    place(p)
  }
  // Brush at the foot of the cut bank, on the unwalkable north strip. (A second run along the south
  // bank put dirt-textured knee-high lobes on walkable ground: the "dirt blobs" by the creek.)
  for (const p of clumps(rng, {
    count: 16,
    minSep: 6,
    members: [2, 4],
    spread: 0.6,
    size: [0.6, 1.1],
    sample: () => {
      const x = rng.range(c.x + 1, c.x + c.w - 1)
      return { x, z: Math.min(c.z - 0.6, bankToe(x)) - rng.range(0.2, 0.9) }
    },
    ok: (x, z) => z < c.z - 0.5 && (x < c.bridge.x - 1.5 || x > c.bridge.x + c.bridge.w + 1.5),
  })) {
    place(p)
  }
  // Gravel down the creek bed, thickest along the trickle: flat stones a few centimetres proud,
  // walk-through by design (they were up to 30 cm pyramids before).
  const mid = c.z + c.d / 2 + 0.6
  for (const p of clumps(rng, {
    count: 46,
    minSep: 4,
    members: [3, 7],
    spread: 0.7,
    size: [0.22, 0.42],
    sample: () => {
      const x = rng.range(c.x - 20, c.x + c.w + 20)
      return { x, z: mid + (rng.next() + rng.next() - 1) * (c.d / 2) }
    },
    ok: (x, z) =>
      z > bankToe(x) &&
      z < c.z + c.d - 0.3 &&
      (x < c.bridge.x - 0.5 || x > c.bridge.x + c.bridge.w + 0.5),
  })) {
    stone(m, rng, p.x, p.z, p.s, 0, 0.05)
  }
  // Loose stones on the outskirts.
  for (const p of clumps(rng, {
    count: 40,
    minSep: 6,
    members: [2, 5],
    spread: 0.9,
    size: [0.25, 0.5],
    sample: () => nearEdge(rng, layout, REACH - 8),
    ok: (x, z) => outside(layout, x, z, 1) && slope(layout, x, z) < 0.6,
  })) {
    stone(m, rng, p.x, p.z, p.s, Math.max(0, terrainHeight(layout, p.x, p.z) - SINK) - 0.02)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(m.pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(m.nor, 3))
  g.setAttribute('uv', new Float32BufferAttribute(m.uv, 2))
  g.setAttribute('color', new Float32BufferAttribute(m.col, 3))
  g.setIndex(m.idx)
  g.computeBoundingSphere()
  return g
}
