// biome-ignore-all lint/complexity/useMaxParams: placement helpers take positional numeric args (x, z, kind, lod, size)
// biome-ignore-all lint/style/noMagicNumbers: terrain shaping and scatter densities, tuned by eye from the street's cameras
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: placement rules are flat checks, kept inline
/**
 * The desert around the duel street: rolling terrain past the town's flat pad (swells, then hills
 * rising toward the mesas), and the plants and boulders scattered over it in seeded clumps:
 * sparse grass by the boardwalks, scrub and cactus behind the buildings, saguaro forests and Joshua
 * trees out on the flats, and a clear wagon road running out of the open end.
 *
 * Everything is deterministic (the float audit and the screenshots depend on it).
 */
import { BufferGeometry, Float32BufferAttribute, type Group, Uint32BufferAttribute } from 'three'
import { gridHeight } from '../ffa/scene/outskirts.ts'
import { Rng } from '../ffa/sim/rng.ts'
import {
  buildFlora,
  clumpScatter,
  floraDensity,
  type Plant,
  type PlantKind,
  pickKind,
} from './flora.ts'
import { BUILDINGS, STREET } from './street.ts'

const SEED = 0x0d_e5_e7_01

const fade = (t: number): number => t * t * (3 - 2 * t)
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (e0: number, e1: number, v: number): number => fade(clamp01((v - e0) / (e1 - e0)))

function lattice(ix: number, iz: number, seed: number): number {
  let h = (ix * 374_761_393 + iz * 668_265_263 + seed * 2_147_483_647) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

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

/** The town's flat pad: the street, the buildings, the water tower and the courthouse. */
const PAD = { x: 30, z0: -64, z1: 84 }

/** Distance outside the flat pad (0 on it). */
function outside(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - PAD.x)
  const dz = Math.max(0, PAD.z0 - z, z - PAD.z1)
  return Math.hypot(dx, dz)
}

/** Terrain height at (x, z): flat on the pad, swells beyond, hills further out. */
export function desertHeight(x: number, z: number): number {
  const d = outside(x, z)
  if (d <= 0) {
    return 0
  }
  const swell =
    (noise(x * 0.025, z * 0.025, 3) - 0.35) * 3.2 + (noise(x * 0.07, z * 0.07, 4) - 0.5) * 0.9
  const hills = Math.max(0, noise(x * 0.008, z * 0.008, 5) - 0.4) * 38
  // the road out of the open end stays a shallow trough
  const road = z < 0 ? smooth(4, 14, Math.abs(x + Math.sin(z * 0.02) * 4)) : 1
  return (Math.max(-0.2, swell) * smooth(0, 30, d) + hills * smooth(60, 200, d)) * road
}

/** Axis lines for the terrain grid: 2.5 m apart at the town, widening to ~25 m at the edge. */
function axis(extent: number): number[] {
  const out = [0]
  let p = 0
  while (p < extent) {
    p += Math.min(25, 2.5 + p * 0.075)
    out.push(Math.min(extent, p))
  }
  return [
    ...out
      .slice(1)
      .map((v) => -v)
      .reverse(),
    ...out,
  ]
}

/** The ground: one grid, finer at the town, its UVs in 4 m tiles. */
export function desertGeometry(extent = 350): BufferGeometry {
  const xs = axis(extent)
  const zs = axis(extent)
  const nx = xs.length
  const nz = zs.length
  const pos = new Float32Array(nx * nz * 3)
  const uv = new Float32Array(nx * nz * 2)
  const nor = new Float32Array(nx * nz * 3)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i] as number
      const z = zs[j] as number
      const k = j * nx + i
      const y = desertHeight(x, z)
      pos.set([x, y, z], k * 3)
      uv.set([x / 4, -z / 4], k * 2)
      const e = 0.5
      const gx = desertHeight(x + e, z) - desertHeight(x - e, z)
      const gz = desertHeight(x, z + e) - desertHeight(x, z - e)
      const l = Math.hypot(gx, 2 * e, gz)
      nor.set([-gx / l, (2 * e) / l, -gz / l], k * 3)
    }
  }
  const idx: number[] = []
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = a + nx
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(new Uint32BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  return g
}

let gridCache: { xs: number[]; h: Float32Array } | null = null

/** The drawn terrain's height at (x, z): its triangles, not the smooth field. */
export function desertMeshHeight(x: number, z: number, extent = 350): number {
  if (!gridCache) {
    const xs = axis(extent)
    const h = new Float32Array(xs.length * xs.length)
    for (const [j, gz] of xs.entries()) {
      for (const [i, gx] of xs.entries()) {
        h[j * xs.length + i] = desertHeight(gx, gz)
      }
    }
    gridCache = { xs, h }
  }
  const c = gridCache
  const n = c.xs.length
  return gridHeight(c.xs, c.xs, (i, j) => c.h[j * n + i] ?? 0, x, z)
}

/** Inside a building's footprint, or another prop's spot (with a margin). */
function blocked(x: number, z: number): boolean {
  const ax = Math.abs(x)
  const side = x > 0 ? 1 : -1
  for (const b of BUILDINGS) {
    if (b.side !== side) {
      continue
    }
    const x0 = STREET.half - 0.2
    const x1 = STREET.half + STREET.boardwalk + b.depth + 0.6
    if (ax > x0 && ax < x1 && Math.abs(z - b.z) < b.w / 2 + 0.5) {
      return true
    }
  }
  // the courthouse and its square
  if (ax < 21 && z > 48 && z < 86) {
    return true
  }
  // the water tower, the fences past the stable, the carts and the hay
  if (Math.hypot(x - 26, z - 24) < 4.5) {
    return true
  }
  if (ax > 20.8 && ax < 23.2 && z > -54 && z < -16) {
    return true
  }
  for (const [px, pz, r] of [
    [-7.1, -30, 3],
    [7, 42, 3],
    [8.3, -42, 2],
    [8.2, -44, 2],
    [-8.3, 35, 2],
    [STREET.posterPos.x, STREET.posterPos.z, 1],
  ] as const) {
    if (Math.hypot(x - px, z - pz) < r) {
      return true
    }
  }
  return false
}

/** The wagon road out of the open end, and the street itself. */
function onRoad(x: number, z: number): boolean {
  if (Math.abs(x) < STREET.half && z > -60 && z < 48) {
    return true
  }
  return z <= -60 && Math.abs(x + Math.sin(z * 0.02) * 4) < 6
}

const NEAR_KINDS: readonly (readonly [PlantKind, number])[] = [
  ['grass', 9],
  ['creosote', 4],
  ['sage', 3],
  ['pear', 1.6],
  ['barrel', 1.2],
  ['cholla', 1],
  ['saguaro', 1.4],
  ['ocotillo', 0.9],
  ['boulder', 1],
  ['snag', 0.25],
]

const FAR_KINDS: readonly (readonly [PlantKind, number])[] = [
  ['saguaro', 5],
  ['joshua', 1.8],
  ['creosote', 4],
  ['sage', 2],
  ['ocotillo', 1.2],
  ['cholla', 1],
  ['boulder', 1.6],
  ['snag', 0.3],
]

/** Chunks: a 50 m grid around the town, eight wedges beyond it. */
function chunkKey(x: number, z: number): string {
  if (Math.abs(x) < 75 && z > -140 && z < 140) {
    return `g${Math.floor(x / 50)},${Math.floor(z / 50)}`
  }
  const a = Math.atan2(z, x)
  return `w${Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8)}`
}

/**
 * Which plants: `street`, the tufts and scrub by the street's boardwalks (they belong to the
 * street, so another duel arena hides them with its buildings); `land`, everything behind the
 * buildings and out to the hills (every arena's); `all`, both.
 */
export type DesertPart = 'street' | 'land' | 'all'

/** Every plant and boulder around the street (seeded). */
export function desertPlants(tier: string, part: DesertPart = 'all'): Plant[] {
  const rng = new Rng(SEED)
  const k = floraDensity(tier)
  const plants: Plant[] = []
  // how far from the street (where the duel's cameras are)
  const edge = (x: number, z: number) => Math.max(Math.abs(x) - 12, z - 60, -64 - z)
  const add = (x: number, z: number, kind: PlantKind, lod: number, s = 1) => {
    const imp = edge(x, z) > 45
    const sz = s * (0.8 + rng.next() * 0.45)
    const seed = (rng.next() * 4_294_967_296) >>> 0
    if (imp && (kind === 'grass' || kind === 'barrel' || kind === 'pear')) {
      return
    }
    plants.push({ kind, x, z, s: sz, seed, lod, imp })
  }
  // 1. by the town: grass at the boardwalks' feet and in the gaps, a little scrub
  const street = clumpScatter(
    rng,
    { x0: -26, z0: -60, x1: 26, z1: 48 },
    Math.round(70 * k),
    [2, 6],
    2.5,
    0.5,
    (x, z) => {
      const ax = Math.abs(x)
      // the open street stays clear: tufts only at its edges
      if (ax < 7.2 || blocked(x, z)) {
        return false
      }
      return ax < STREET.half || ax > STREET.half + STREET.boardwalk
    },
  )
  for (const p of street) {
    const ax = Math.abs(p.x)
    add(
      p.x,
      p.z,
      ax < STREET.half + 1 || rng.next() < 0.7
        ? 'grass'
        : pickKind(rng, [
            ['sage', 2],
            ['creosote', 2],
            ['pear', 0.6],
            ['barrel', 0.5],
          ]),
      0,
      ax < STREET.half ? 0.8 : 1,
    )
  }
  const streetEnd = plants.length
  // 2. behind the buildings and out past both ends: dense, varied, clumped
  const ring = clumpScatter(
    rng,
    { x0: -75, z0: -140, x1: 75, z1: 140 },
    Math.round(170 * k),
    [3, 8],
    7,
    1.2,
    (x, z) => {
      if (blocked(x, z) || onRoad(x, z)) {
        return false
      }
      return Math.abs(x) > 23.5 || z < -58 || z > 50
    },
  )
  for (const p of ring) {
    const kind = pickKind(rng, NEAR_KINDS)
    add(p.x, p.z, kind, 0, kind === 'saguaro' ? 0.9 : 1)
  }
  // 3. out on the flats to the hills: saguaro forests and Joshua stands, coarser
  const far = clumpScatter(
    rng,
    { x0: -280, z0: -300, x1: 280, z1: 300 },
    Math.round(115 * k),
    [3, 7],
    16,
    4,
    (x, z) => {
      if (onRoad(x, z) || (Math.abs(x) < 75 && z > -140 && z < 140)) {
        return false
      }
      const r = Math.hypot(x, z)
      return r < 300 && desertHeight(x, z) < 14
    },
  )
  for (const p of far) {
    const kind = pickKind(rng, FAR_KINDS)
    add(p.x, p.z, kind, 1, kind === 'boulder' ? 1.6 : 1.1)
  }
  if (part === 'street') {
    return plants.slice(0, streetEnd)
  }
  return part === 'land' ? plants.slice(streetEnd) : plants
}

/** The desert's plants baked into chunked meshes. */
export function buildDesert(tier: string, part: DesertPart = 'all'): Group {
  return buildFlora(desertPlants(tier, part), {
    heightAt: (x, z) => desertMeshHeight(x, z),
    chunk: 50,
    chunkKey,
    shadowNear: { x: 0, z: 0, r: 80 },
  })
}
