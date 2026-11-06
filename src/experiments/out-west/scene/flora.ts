// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noMagicNumbers: plant proportions and colours, tuned by eye
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the coplanarity check is a flat nested scan over two small blobs
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one module for every desert plant: they share the builder, the material and the scatter
/**
 * Desert plants, built procedurally: saguaros (heights and arm counts vary), Joshua trees, barrel
 * cactus, prickly pear, teddy-bear cholla, ocotillo, creosote and sage clumps, dry grass tufts,
 * dead snags and boulders. No textures: ribs, bark and spines are vertex colour plus a world-space
 * detail noise in the shader, and everything that bends in the wind (grass, shrubs, ocotillo canes,
 * Joshua tree crowns) carries a per-vertex sway weight the vertex shader animates.
 *
 * Plants are baked in world space into a few merged, static meshes (chunked on a grid so the
 * frustum culls the chunks the camera can't see): one draw per chunk, no per-frame CPU. Vertices are
 * compact (float position, byte colour, byte sway).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Uint8BufferAttribute,
  Uint32BufferAttribute,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three'
import { Rng } from '../ffa/sim/rng.ts'
import { bindAtmos, withCloudShadow } from './atmos.ts'
import { buildImpostors } from './impostor.ts'
import { releaseAfterUpload } from './release.ts'
import { markRole, ROLE } from './roles.ts'

export type PlantKind =
  | 'saguaro'
  | 'joshua'
  | 'barrel'
  | 'pear'
  | 'cholla'
  | 'ocotillo'
  | 'creosote'
  | 'sage'
  | 'grass'
  | 'snag'
  | 'boulder'

export interface Plant {
  kind: PlantKind
  x: number
  z: number
  /** Size multiplier around the species' typical size. */
  s: number
  /** Seed for this plant's shape. */
  seed: number
  /** 0 = full detail, 1 = far (fewer sides and rings). */
  lod: number
  /** Drawn as an impostor card pair (far from every camera), not a mesh. */
  imp?: boolean
}

// ---------------------------------------------------------------- builder

const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpN = new Vector3()

class PlantGeo {
  readonly pos: number[] = []
  readonly nor: number[] = []
  readonly col: number[] = []
  readonly sway: number[] = []
  readonly idx: number[] = []

  get count(): number {
    return this.pos.length / 3
  }

  vert(p: Vector3, n: Vector3, c: Color, sway: number): number {
    this.pos.push(p.x, p.y, p.z)
    this.nor.push(n.x, n.y, n.z)
    this.col.push(c.r, c.g, c.b)
    this.sway.push(Math.min(1, Math.max(0, sway)))
    return this.count - 1
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c)
  }

  /**
   * A tube along a polyline: rings of `sides` vertices (parallel-transported frames), radius per
   * point, closed with a domed tip when `tip` > 0. `color(side, t)` paints ribs and bark.
   */
  tube(
    path: Vector3[],
    radius: (t: number) => number,
    sides: number,
    color: (side: number, t: number) => Color,
    sway: (t: number) => number,
    tip = 0,
    phase = 0,
  ): void {
    const n = path.length
    if (n < 2) {
      return
    }
    const tangent = (i: number) =>
      new Vector3()
        .subVectors(path[Math.min(n - 1, i + 1)] as Vector3, path[Math.max(0, i - 1)] as Vector3)
        .normalize()
    let t0 = tangent(0)
    let u = Math.abs(t0.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
    u = u.sub(t0.clone().multiplyScalar(u.dot(t0))).normalize()
    if (phase !== 0) {
      u.applyAxisAngle(t0, phase)
    }
    const base = this.count
    for (let i = 0; i < n; i++) {
      const t1 = tangent(i)
      // parallel transport: rotate the frame by the tangent's turn
      const axis = tmpA.crossVectors(t0, t1)
      const sin = axis.length()
      if (sin > 1e-5) {
        axis.normalize()
        u.applyAxisAngle(axis, Math.asin(Math.min(1, sin)))
      }
      t0 = t1
      const v = tmpB.crossVectors(t1, u).normalize()
      const f = i / (n - 1)
      const r = radius(f)
      const p = path[i] as Vector3
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2
        tmpN.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a))
        const q = p.clone().addScaledVector(tmpN, r)
        this.vert(q, tmpN, color(k, f), sway(f))
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const a = base + i * sides + k
        const b = base + i * sides + ((k + 1) % sides)
        const c = a + sides
        const d = b + sides
        this.tri(a, c, b)
        this.tri(b, c, d)
      }
    }
    if (tip > 0) {
      const last = path[n - 1] as Vector3
      const dir = tangent(n - 1)
      const apex = this.vert(last.clone().addScaledVector(dir, tip), dir, color(0, 1), sway(1))
      const ring = base + (n - 1) * sides
      for (let k = 0; k < sides; k++) {
        this.tri(ring + k, apex, ring + ((k + 1) % sides))
      }
    }
  }

  /** A lumpy, roughly round blob (an octahedron subdivided once), squashed by `r`. */
  blob(
    c: Vector3,
    r: Vector3,
    color: (n: Vector3) => Color,
    sway: (n: Vector3) => number,
    jit: number,
    rng: Rng,
  ): { p: Vector3; d: Vector3 }[] {
    const out: { p: Vector3; d: Vector3 }[] = []
    const base = this.count
    // each blob turned its own way, so two never share a face plane
    const turn = rng.next() * Math.PI * 2
    // and tipped a little about a random level axis (the octahedron is 4-fold symmetric about Y)
    const tipAxis = new Vector3(Math.cos(turn * 3.7), 0, Math.sin(turn * 3.7))
    // (an unjittered blob stays upright: none of its faces is then ever vertical, so it can't lie
    // flat against a pad)
    const tip = jit > 0 ? 0.15 + rng.next() * 0.3 : 0
    for (const d0 of OCTA_DIRS) {
      const d = d0.clone().applyAxisAngle(UP, turn).applyAxisAngle(tipAxis, tip)
      const k = 1 + (rng.next() - 0.5) * jit
      const p = new Vector3(c.x + d.x * r.x * k, c.y + d.y * r.y * k, c.z + d.z * r.z * k)
      this.vert(p, d, color(d), sway(d))
      out.push({ p, d })
    }
    for (const [a, b, cc] of OCTA_TRIS) {
      this.tri(base + a, base + b, base + cc)
    }
    return out
  }

  /** One thin leaf, spike or blade, two-sided (back to back), base to tip. */
  blade(
    base: Vector3,
    tip: Vector3,
    width: number,
    cBase: Color,
    cTip: Color,
    swayBase: number,
    swayTip: number,
    anchored = false,
  ): void {
    const dir = tmpA.subVectors(tip, base)
    const side = tmpB.set(-dir.z, 0, dir.x)
    if (side.lengthSq() < 1e-8) {
      side.set(1, 0, 0)
    }
    side.normalize().multiplyScalar(width / 2)
    const n = new Vector3().crossVectors(dir, side).normalize()
    if (n.y < 0) {
      n.negate()
    }
    const nb = n.clone().negate()
    // anchored: one corner exactly on `base` (a vertex of what it grows from, so they weld)
    const p0 = anchored ? base.clone().addScaledVector(side, 2) : base.clone().add(side)
    const p1 = anchored ? base.clone() : base.clone().sub(side)
    const a = this.vert(p0, n, cBase, swayBase)
    const b = this.vert(p1, n, cBase, swayBase)
    const c = this.vert(tip, n, cTip, swayTip)
    this.tri(a, b, c)
    const a2 = this.vert(p0, nb, cBase, swayBase)
    const b2 = this.vert(p1, nb, cBase, swayBase)
    const c2 = this.vert(tip, nb, cTip, swayTip)
    this.tri(b2, a2, c2)
  }

  /** A flat pad (prickly pear): an octagon slab, facing `normal`, long axis `up`. */
  pad(
    c: Vector3,
    normal: Vector3,
    up: Vector3,
    w: number,
    h: number,
    col: Color,
    rim: Color,
  ): void {
    const side = new Vector3().crossVectors(up, normal).normalize()
    const sides = 8
    for (const face of [1, -1]) {
      const fn = normal.clone().multiplyScalar(face)
      // each face flat (a cone would tip its triangles toward a neighbour pad's plane); the
      // rounded edge normals give it its thickness
      const center = c.clone()
      const ci = this.vert(center, fn, col, 0)
      const ring: number[] = []
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2
        const p = c
          .clone()
          .addScaledVector(side, Math.cos(a) * w)
          .addScaledVector(up, Math.sin(a) * h)
        // both faces share the rim, so the pad is one closed piece
        // edge normals lean outward so the slab reads rounded
        const en = fn
          .clone()
          .multiplyScalar(0.6)
          .addScaledVector(side, Math.cos(a) * 0.5)
          .addScaledVector(up, Math.sin(a) * 0.5)
          .normalize()
        ring.push(this.vert(p, en, rim, 0))
      }
      for (let k = 0; k < sides; k++) {
        const a = ring[k] as number
        const b = ring[(k + 1) % sides] as number
        if (face === 1) {
          this.tri(ci, a, b)
        } else {
          this.tri(ci, b, a)
        }
      }
    }
  }

  /** A faceted boulder: an icosahedron, flat-shaded, its vertices pushed about. */
  rock(c: Vector3, r: Vector3, color: Color, rng: Rng, ry: number): void {
    const v = ICO_VERTS.map((p) => {
      const k = 0.78 + rng.next() * 0.4
      return new Vector3(p.x * r.x * k, p.y * r.y * k, p.z * r.z * k).applyAxisAngle(UP, ry).add(c)
    })
    for (const [a, b, d] of ICO_TRIS) {
      const pa = v[a] as Vector3
      const pb = v[b] as Vector3
      const pd = v[d] as Vector3
      const n = new Vector3().subVectors(pb, pa).cross(new Vector3().subVectors(pd, pa)).normalize()
      // faces that look up catch dust; undersides are darker
      const k = 0.82 + 0.28 * Math.max(0, n.y) + (rng.next() - 0.5) * 0.08
      const cc = color.clone().multiplyScalar(k)
      const i0 = this.vert(pa, n, cc, 0)
      const i1 = this.vert(pb, n, cc, 0)
      const i2 = this.vert(pd, n, cc, 0)
      this.tri(i0, i1, i2)
    }
  }

  build(): BufferGeometry | null {
    if (this.idx.length === 0) {
      return null
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3))
    const nor = new Int8Array(this.nor.length)
    for (let i = 0; i < nor.length; i++) {
      nor[i] = Math.round(Math.max(-1, Math.min(1, this.nor[i] as number)) * 127)
    }
    g.setAttribute('normal', new BufferAttribute(nor, 3, true))
    const col = new Uint8Array(this.col.length)
    for (let i = 0; i < col.length; i++) {
      // stored in sRGB bytes would band; these are linear 0..1, scaled up into the byte range
      col[i] = Math.round(Math.min(1, Math.max(0, this.col[i] as number)) * 255)
    }
    g.setAttribute('color', new Uint8BufferAttribute(col, 3, true))
    const sw = new Uint8Array(this.sway.length)
    for (let i = 0; i < sw.length; i++) {
      sw[i] = Math.round((this.sway[i] as number) * 255)
    }
    g.setAttribute('sway', new Uint8BufferAttribute(sw, 1, true))
    g.setIndex(new Uint32BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

const UP = new Vector3(0, 1, 0)

/** Octahedron subdivided once: 18 directions, 32 faces. */
const OCTA_DIRS: Vector3[] = []
const OCTA_TRIS: [number, number, number][] = []
{
  const base = [
    new Vector3(1, 0, 0),
    new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, -1, 0),
    new Vector3(0, 0, 1),
    new Vector3(0, 0, -1),
  ]
  const faces: [number, number, number][] = [
    [2, 4, 0],
    [2, 0, 5],
    [2, 5, 1],
    [2, 1, 4],
    [3, 0, 4],
    [3, 5, 0],
    [3, 1, 5],
    [3, 4, 1],
  ]
  const verts = base.map((v) => v.clone())
  const mid = new Map<string, number>()
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    const got = mid.get(key)
    if (got !== undefined) {
      return got
    }
    verts.push(new Vector3().addVectors(verts[a] as Vector3, verts[b] as Vector3).normalize())
    mid.set(key, verts.length - 1)
    return verts.length - 1
  }
  for (const [a, b, c] of faces) {
    const ab = midpoint(a, b)
    const bc = midpoint(b, c)
    const ca = midpoint(c, a)
    OCTA_TRIS.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca])
  }
  OCTA_DIRS.push(...verts)
}

/** Icosahedron: 12 vertices, 20 faces. */
const ICO_VERTS: Vector3[] = []
const ICO_TRIS: [number, number, number][] = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
]
{
  const t = (1 + Math.sqrt(5)) / 2
  for (const [x, y, z] of [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ] as const) {
    ICO_VERTS.push(new Vector3(x, y, z).normalize())
  }
}

// ---------------------------------------------------------------- palette (linear)

const C = (hex: number) => new Color(hex)
const SAGUARO_DARK = C(0x2c_4a_2a)
const SAGUARO_LIGHT = C(0x4f_6e_3c)
const SAGUARO_TOP = C(0x7a_80_4a)
const BARK = C(0x5e_50_42)
const BARK_DARK = C(0x3a_30_28)
const JOSHUA_LEAF = C(0x4e_5e_2a)
const JOSHUA_TIP = C(0x9a_a2_58)
const JOSHUA_DEAD = C(0x8a_6e_4a)
const PEAR = C(0x5e_7e_4a)
const PEAR_RIM = C(0x86_8a_52)
const PEAR_FRUIT = C(0x8a_1e_3a)
const CHOLLA = C(0xd8_c8_8a)
const CHOLLA_DARK = C(0x4a_3e_30)
const OCOTILLO = C(0x5a_5c_3e)
const OCO_FLOWER = C(0xe0_3a_18)
const BARREL = C(0x4a_68_36)
const BARREL_SPINE = C(0xa8_4a_2a)
const BARREL_FLOWER = C(0xf0_c0_30)
const CREOSOTE = C(0x5a_66_30)
const CREOSOTE_TIP = C(0x7e_8a_3c)
const SAGE = C(0x8a_92_7a)
const SAGE_TIP = C(0xa8_ae_96)
const GRASS = C(0xc4_a8_68)
const GRASS_BASE = C(0x7a_68_40)
const SNAG = C(0x8e_86_7c)

const ROCKS = [C(0x9a_5a_3e), C(0xa8_74_52), C(0x8a_6e_5a), C(0xb4_86_60), C(0x7a_5a_48)]

const jitter = (c: Color, rng: Rng, k: number): Color =>
  c.clone().multiplyScalar(1 + (rng.next() - 0.5) * k)

// ---------------------------------------------------------------- species

function saguaro(
  g: PlantGeo,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  s: number,
  lod: number,
): void {
  const h = (5 + rng.next() * 6.5) * s
  const r = 0.2 + h * 0.022
  const sides = lod > 0 ? 6 : 8
  const lean = new Vector3((rng.next() - 0.5) * 0.06, 1, (rng.next() - 0.5) * 0.06).normalize()
  const segs = lod > 0 ? 3 : 4
  const trunk: Vector3[] = []
  for (let i = 0; i <= segs; i++) {
    trunk.push(new Vector3(x, y - 0.02, z).addScaledVector(lean, (h * i) / segs))
  }
  const tint = 1 + (rng.next() - 0.5) * 0.18
  const ribs = (side: number, t: number) => {
    const c = (side % 2 === 0 ? SAGUARO_DARK : SAGUARO_LIGHT).clone().multiplyScalar(tint)
    // a woody, dusty foot and a paler crown
    if (t < 0.08) {
      c.lerp(BARK, (0.08 - t) * 8)
    }
    return t > 0.88 ? c.lerp(SAGUARO_TOP, (t - 0.88) * 5) : c
  }
  g.tube(
    trunk,
    (t) => r * (1.05 - t * 0.12) * (t < 0.04 ? 1.06 : 1),
    sides,
    ribs,
    () => 0,
    r * 0.7,
  )
  // arms: young saguaros have none, old ones up to five
  const arms = h < 6 * s ? Math.floor(rng.next() * 2) : 1 + Math.floor(rng.next() * 4.5)
  for (let a = 0; a < arms; a++) {
    const at = h * (0.35 + rng.next() * 0.3)
    const ang = rng.next() * Math.PI * 2
    const dir = new Vector3(Math.cos(ang), 0, Math.sin(ang))
    const out = 0.45 + rng.next() * 0.55
    const up = (0.9 + rng.next() * 1.8) * Math.min(1, (h - at) / 2.2 + 0.4)
    const ar = r * (0.7 + rng.next() * 0.12)
    const o = new Vector3(x, y, z).addScaledVector(lean, at)
    const path = [
      // from behind the trunk's axis, so the arm runs out through the trunk's wall
      o.clone().addScaledVector(dir, -r * 0.9),
      o
        .clone()
        .addScaledVector(dir, r + out * 0.55)
        .add(new Vector3(0, -0.06, 0)),
      o
        .clone()
        .addScaledVector(dir, r + out)
        .add(new Vector3(0, 0.22, 0)),
      o
        .clone()
        .addScaledVector(dir, r + out * 1.05)
        .add(new Vector3(0, 0.6, 0)),
      o
        .clone()
        .addScaledVector(dir, r + out * 1.02)
        .add(new Vector3(0, 0.6 + up * 0.5, 0)),
      o
        .clone()
        .addScaledVector(dir, r + out)
        .add(new Vector3(0, 0.6 + up, 0)),
    ]
    g.tube(
      lod > 0
        ? [path[0] as Vector3, path[2] as Vector3, path[3] as Vector3, path[5] as Vector3]
        : path,
      () => ar,
      lod > 0 ? 4 : 6,
      ribs,
      () => 0,
      ar * 0.7,
    )
  }
}

function joshua(
  g: PlantGeo,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  s: number,
  lod: number,
): void {
  const h = (2.2 + rng.next() * 2.2) * s
  const r = 0.16 * s + 0.04
  const base = new Vector3(x, y - 0.02, z)
  const top = base.clone().add(new Vector3((rng.next() - 0.5) * 0.4, h, (rng.next() - 0.5) * 0.4))
  const bark = (side: number, t: number) =>
    (side % 3 === 0 ? BARK_DARK : BARK).clone().multiplyScalar(0.9 + t * 0.3)
  const mid = base
    .clone()
    .lerp(top, 0.5)
    .add(new Vector3((rng.next() - 0.5) * 0.3, 0, (rng.next() - 0.5) * 0.3))
  g.tube(
    [base, mid, top],
    (t) => r * (1.15 - t * 0.35),
    lod > 0 ? 5 : 7,
    bark,
    (t) => t * 0.1,
  )
  const tips: { p: Vector3; d: Vector3; r: number }[] = []
  const grow = (from: Vector3, dir: Vector3, len: number, rr: number, depth: number) => {
    const end = from.clone().addScaledVector(dir, len)
    const m = from
      .clone()
      .lerp(end, 0.5)
      .add(new Vector3(0, len * 0.08, 0))
    // a child starts thinner than its parent ends (no shared ring, no coplanar faces)
    g.tube(
      [from, m, end],
      (t) => rr * (0.86 - t * 0.2),
      (lod > 0 ? 4 : 5) + (depth % 2),
      bark,
      (t) => 0.1 + t * 0.15,
      rr * 0.4,
    )
    if (depth <= 0 || rng.next() < 0.18) {
      tips.push({ p: end, d: dir, r: rr * 0.7 })
      return
    }
    const n = 2 + (rng.next() < 0.3 ? 1 : 0)
    const turn = rng.next() * Math.PI * 2
    for (let i = 0; i < n; i++) {
      // siblings fan out evenly: two never grow into one another
      const ang = turn + ((i + rng.next() * 0.4) / n) * Math.PI * 2
      const spread = 0.5 + rng.next() * 0.5
      const nd = new Vector3(
        dir.x + Math.cos(ang) * spread,
        Math.max(0.35, dir.y + 0.25),
        dir.z + Math.sin(ang) * spread,
      ).normalize()
      grow(end, nd, len * (0.75 + rng.next() * 0.2), rr * 0.72, depth - 1)
    }
  }
  const nb = 2 + Math.floor(rng.next() * 2)
  for (let i = 0; i < nb; i++) {
    const ang = (i / nb) * Math.PI * 2 + rng.next()
    const d = new Vector3(Math.cos(ang) * 0.7, 0.75, Math.sin(ang) * 0.7).normalize()
    grow(top, d, (0.8 + rng.next() * 0.6) * s, r * 0.75, 1 + Math.floor(rng.next() * 2))
  }
  // a spiky rosette at every tip, a skirt of dead leaves hanging under it
  for (const t of tips) {
    const n = lod > 0 ? 6 : 8
    const len = 0.32 + rng.next() * 0.12
    for (let i = 0; i < n; i++) {
      // a golden-angle spiral: every leaf in its own direction, never two in one plane
      const u = (i + 0.5) / n
      const ang = i * 2.399 + rng.next() * 0.3
      const el = 0.15 + u * 1.25
      const d = new Vector3(
        Math.cos(ang) * Math.cos(el),
        Math.sin(el),
        Math.sin(ang) * Math.cos(el),
      )
      // each leaf from its own spot on the stub, so no two ever lie in one plane
      const b = t.p.clone().addScaledVector(t.d, -0.04 * u)
      g.blade(
        b,
        b.clone().addScaledVector(d, len),
        0.07,
        JOSHUA_LEAF,
        jitter(JOSHUA_TIP, rng, 0.2),
        0.2,
        0.5,
      )
    }
    const skirtTop = t.p.clone().addScaledVector(t.d, -0.02)
    const skirtBot = t.p.clone().addScaledVector(t.d, -0.34)
    // hugging the branch at its foot, flaring out under the rosette
    g.tube(
      [skirtBot, skirtTop],
      (q) => t.r * 0.7 + q * 0.09,
      5,
      () => jitter(JOSHUA_DEAD, rng, 0.2),
      () => 0.2,
    )
  }
}

function barrel(
  g: PlantGeo,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  s: number,
  lod: number,
): void {
  const r = (0.22 + rng.next() * 0.2) * s
  const h = r * (1.2 + rng.next() * 0.9)
  const path: Vector3[] = []
  const rings = lod > 0 ? 3 : 5
  for (let i = 0; i <= rings; i++) {
    path.push(new Vector3(x, y - 0.02 + (h * i) / rings, z))
  }
  const sides = lod > 0 ? 8 : 14
  g.tube(
    path,
    (t) => r * (0.8 + 0.3 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.9)),
    sides,
    (side, t) =>
      side % 2 === 0 ? BARREL_SPINE.clone().lerp(BARREL, 0.45 + t * 0.2) : BARREL.clone(),
    () => 0,
    r * 0.25,
  )
  // a ring of yellow flowers on the crown
  if (rng.next() < 0.7) {
    const c = new Vector3(x, y + h + r * 0.12, z)
    g.blob(
      c,
      new Vector3(r * 0.45, r * 0.18, r * 0.45),
      () => BARREL_FLOWER,
      () => 0,
      0.3,
      rng,
    )
  }
}

function pear(g: PlantGeo, rng: Rng, x: number, y: number, z: number, s: number): void {
  const n = 4 + Math.floor(rng.next() * 7)
  const tint = rng.next() < 0.25 ? C(0x6e_6a_5a) : PEAR
  const pads: { c: Vector3; up: Vector3; nrm: Vector3; h: number }[] = []
  const turn = rng.next() * Math.PI
  for (let i = 0; i < n; i++) {
    const w = (0.17 + rng.next() * 0.07) * s
    const h = w * 1.3
    const parent = i < 2 || pads.length === 0 ? null : pads[Math.floor(rng.next() * pads.length)]
    // pads face golden-angle steps round a half turn: no two ever lie in one plane
    const ang = turn + ((i * 0.618_034) % 1) * Math.PI + rng.next() * 0.05
    const nrm = new Vector3(Math.cos(ang), 0, Math.sin(ang))
    const tilt = (rng.next() - 0.5) * 1.1
    const up = new Vector3(
      -nrm.z * Math.sin(tilt),
      Math.cos(tilt),
      nrm.x * Math.sin(tilt),
    ).normalize()
    let c: Vector3
    if (parent) {
      // sprouting from the parent pad's top edge
      c = parent.c
        .clone()
        .addScaledVector(parent.up, parent.h * 0.85)
        .addScaledVector(up, h * 0.85)
    } else {
      c = new Vector3(
        x + (rng.next() - 0.5) * 0.3 * s,
        y + h * 0.82,
        z + (rng.next() - 0.5) * 0.3 * s,
      )
      up.set(up.x * 0.5, 1, up.z * 0.5).normalize()
    }
    g.pad(c, nrm, up, w, h, jitter(tint, rng, 0.15), PEAR_RIM)
    pads.push({ c, up, nrm, h })
    if (rng.next() < 0.35) {
      // a fruit somewhere along the pad's top edge, each its own size
      const along = new Vector3().crossVectors(up, nrm).normalize()
      const f = c
        .clone()
        .addScaledVector(up, h * 0.95)
        .addScaledVector(along, (rng.next() - 0.5) * w * 0.8)
      g.blob(
        f,
        new Vector3(0.035, 0.05, 0.035).multiplyScalar(s * (0.8 + rng.next() * 0.45)),
        () => PEAR_FRUIT,
        () => 0,
        0,
        rng,
      )
    }
  }
}

function cholla(
  g: PlantGeo,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  s: number,
  lod: number,
): void {
  const h = (0.8 + rng.next() * 0.8) * s
  const trunk = [
    new Vector3(x, y - 0.02, z),
    new Vector3(x + (rng.next() - 0.5) * 0.15, y + h, z + (rng.next() - 0.5) * 0.15),
  ]
  g.tube(
    trunk,
    (t) => 0.08 * s * (1 - t * 0.2),
    5,
    (_k, t) => CHOLLA_DARK.clone().lerp(CHOLLA, t * t),
    () => 0,
    0.04,
  )
  const arms = 5 + Math.floor(rng.next() * 6)
  for (let i = 0; i < arms; i++) {
    const t = 0.45 + rng.next() * 0.55
    const from = trunk[0]?.clone().lerp(trunk[1] as Vector3, t) ?? new Vector3()
    const ang = rng.next() * Math.PI * 2
    let p = from
    let d = new Vector3(Math.cos(ang), 0.5 + rng.next() * 0.6, Math.sin(ang)).normalize()
    const joints = 2 + Math.floor(rng.next() * 2)
    for (let j = 0; j < joints; j++) {
      const len = (0.16 + rng.next() * 0.1) * s
      const end = p.clone().addScaledVector(d, len)
      // each joint a little thinner, set into the last one's tip
      const jr = 0.055 * s * (1 - 0.14 * j)
      // joints alternate their side count, so two never share a face plane
      g.tube(
        [p, end],
        (q) => jr * (1.08 - 0.22 * q),
        (lod > 0 ? 4 : 5) + ((i + j * 2) % 3),
        () => jitter(CHOLLA, rng, 0.15),
        () => 0,
        0.03,
        rng.next() * Math.PI,
      )
      p = end.clone().addScaledVector(d, -0.03)
      d = d
        .clone()
        .add(new Vector3((rng.next() - 0.5) * 0.8, 0.2, (rng.next() - 0.5) * 0.8))
        .normalize()
    }
  }
}

function ocotillo(
  g: PlantGeo,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  s: number,
  lod: number,
): void {
  const canes = (lod > 0 ? 6 : 9) + Math.floor(rng.next() * 5)
  const flowering = rng.next() < 0.6
  for (let i = 0; i < canes; i++) {
    const ang = rng.next() * Math.PI * 2
    const spread = 0.1 + rng.next() * 0.32
    const len = (2.4 + rng.next() * 2.2) * s
    const d = new Vector3(Math.cos(ang) * spread, 1, Math.sin(ang) * spread).normalize()
    const base = new Vector3(x + Math.cos(ang) * 0.06, y - 0.02, z + Math.sin(ang) * 0.06)
    const path: Vector3[] = []
    for (let k = 0; k <= 4; k++) {
      const t = k / 4
      path.push(
        base
          .clone()
          .addScaledVector(d, len * t)
          .add(new Vector3(Math.cos(ang) * t * t * 0.35 * s, 0, Math.sin(ang) * t * t * 0.35 * s)),
      )
    }
    g.tube(
      path,
      (t) => 0.035 * s * (1 - t * 0.6),
      lod > 0 ? 3 : 4,
      (_k, t) => OCOTILLO.clone().multiplyScalar(0.85 + t * 0.3),
      (t) => t * t,
    )
    const tip = path[4] as Vector3
    if (flowering) {
      const fd = tip
        .clone()
        .sub(path[3] as Vector3)
        .normalize()
      g.blade(
        tip.clone().addScaledVector(fd, -0.05),
        tip.clone().addScaledVector(fd, 0.22 * s),
        0.07,
        OCO_FLOWER,
        C(0xff_6a_2a),
        1,
        1,
      )
    }
  }
}

function shrub(
  g: PlantGeo,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  s: number,
  kind: 'creosote' | 'sage',
  lod: number,
): void {
  const lobes = lod > 0 ? 1 : 2 + Math.floor(rng.next() * 2)
  const col = kind === 'sage' ? SAGE : CREOSOTE
  const tip = kind === 'sage' ? SAGE_TIP : CREOSOTE_TIP
  const big = kind === 'creosote' ? 1.5 : 1
  const placed: { first: number; n: number }[] = []
  for (let i = 0; i < lobes; i++) {
    const r = (0.28 + rng.next() * 0.28) * s * big
    const ox = (rng.next() - 0.5) * r * 1.4
    const oz = (rng.next() - 0.5) * r * 1.4
    const ry = r * (0.6 + rng.next() * 0.25)
    const c = new Vector3(x + ox, y + ry * 0.75 - 0.03, z + oz)
    const base = jitter(col, rng, 0.2)
    const first = g.count
    const verts = g.blob(
      c,
      new Vector3(r, ry, r),
      (n) =>
        base
          .clone()
          .lerp(tip, Math.max(0, n.y) * 0.6)
          .multiplyScalar(n.y < -0.3 ? 0.55 : 1),
      (n) => Math.max(0, n.y + 0.4) * 0.45,
      0.45,
      rng,
    )
    separate(g, placed, first, verts.length)
    placed.push({ first, n: verts.length })
    // (separate may have moved it: the twigs anchor on where its vertices are now)
    for (const [k, vt] of verts.entries()) {
      const at = (first + k) * 3
      vt.p.set(g.pos[at] ?? 0, g.pos[at + 1] ?? 0, g.pos[at + 2] ?? 0)
    }
    if (lod === 0) {
      // twigs and leafy sprigs breaking out of the crown (welded to its vertices), so it reads as
      // a bush, not a lump
      for (const v of verts) {
        if (v.d.y < 0.05 || rng.next() < (kind === 'creosote' ? 0.25 : 0.5)) {
          continue
        }
        const to = v.p
          .clone()
          .addScaledVector(v.d, r * (0.35 + rng.next() * 0.35))
          .add(new Vector3(0, r * 0.15, 0))
        const sw = Math.max(0, v.d.y + 0.4) * 0.45
        g.blade(v.p, to, 0.035 * s * big, base, tip, sw, Math.min(1, sw + 0.4), true)
      }
    }
  }
}

/**
 * Nudge a freshly built blob (vertices `first`..`first + n`) off any face of the blobs already
 * placed that it would lie in the same plane as (two coplanar overlapping faces flicker).
 */
function separate(
  g: PlantGeo,
  placed: readonly { first: number; n: number }[],
  first: number,
  n: number,
): void {
  const P = g.pos
  const v = (i: number) => new Vector3(P[i * 3] ?? 0, P[i * 3 + 1] ?? 0, P[i * 3 + 2] ?? 0)
  const face = (b: number, t: readonly [number, number, number]) => {
    const a = v(b + t[0])
    const nrm = new Vector3()
      .subVectors(v(b + t[1]), a)
      .cross(new Vector3().subVectors(v(b + t[2]), a))
    return { a, nrm: nrm.normalize() }
  }
  for (let pass = 0; pass < 4; pass++) {
    let clash: Vector3 | null = null
    for (const o of placed) {
      for (const ta of OCTA_TRIS) {
        const fa = face(o.first, ta)
        for (const tb of OCTA_TRIS) {
          const fb = face(first, tb)
          if (fa.nrm.dot(fb.nrm) > 0.995 && Math.abs(fa.nrm.dot(fb.a.clone().sub(fa.a))) < 0.008) {
            clash = fa.nrm
            break
          }
        }
        if (clash) {
          break
        }
      }
      if (clash) {
        break
      }
    }
    if (!clash) {
      return
    }
    for (let i = first; i < first + n; i++) {
      P[i * 3] = (P[i * 3] ?? 0) + clash.x * 0.03
      P[i * 3 + 1] = (P[i * 3 + 1] ?? 0) + clash.y * 0.03
      P[i * 3 + 2] = (P[i * 3 + 2] ?? 0) + clash.z * 0.03
    }
  }
}

function grass(g: PlantGeo, rng: Rng, x: number, y: number, z: number, s: number): void {
  const n = 5 + Math.floor(rng.next() * 4)
  const tint = 0.85 + rng.next() * 0.3
  const turn = rng.next() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    // spread round the tuft, each from its own spot: no two blades share a plane
    const ang = turn + ((i + 0.3 * rng.next()) / n) * Math.PI * 2
    const lean = 0.2 + rng.next() * 0.55
    const len = (0.28 + rng.next() * 0.32) * s
    const off = 0.02 + 0.05 * rng.next()
    const b = new Vector3(x + Math.cos(ang) * off, y - 0.015, z + Math.sin(ang) * off)
    const t = b
      .clone()
      .add(new Vector3(Math.cos(ang) * lean * len, len, Math.sin(ang) * lean * len))
    g.blade(b, t, 0.035, GRASS_BASE, GRASS.clone().multiplyScalar(tint), 0, 1)
  }
}

function snag(g: PlantGeo, rng: Rng, x: number, y: number, z: number, s: number): void {
  const h = (2.2 + rng.next() * 2.4) * s
  const base = new Vector3(x, y - 0.02, z)
  const top = base.clone().add(new Vector3((rng.next() - 0.5) * 0.8, h, (rng.next() - 0.5) * 0.8))
  const m = base
    .clone()
    .lerp(top, 0.45)
    .add(new Vector3((rng.next() - 0.5) * 0.5, 0, (rng.next() - 0.5) * 0.5))
  const grey = (side: number, t: number) =>
    SNAG.clone().multiplyScalar((side % 2 === 0 ? 0.85 : 1.05) * (0.8 + t * 0.3))
  g.tube(
    [base, m, top],
    (t) => 0.16 * s * (1 - t * 0.6),
    6,
    grey,
    () => 0,
    0.05,
  )
  const branches = 3 + Math.floor(rng.next() * 4)
  for (let i = 0; i < branches; i++) {
    const t = 0.35 + rng.next() * 0.6
    const from = t < 0.45 ? base.clone().lerp(m, t / 0.45) : m.clone().lerp(top, (t - 0.45) / 0.55)
    const ang = rng.next() * Math.PI * 2
    const d = new Vector3(Math.cos(ang), 0.35 + rng.next() * 0.6, Math.sin(ang)).normalize()
    const len = (0.6 + rng.next() * 1.1) * s
    const mid = from
      .clone()
      .addScaledVector(d, len * 0.5)
      .add(new Vector3(0, len * 0.1, 0))
    const end = from
      .clone()
      .addScaledVector(d, len)
      .add(new Vector3((rng.next() - 0.5) * 0.3, 0, 0))
    g.tube(
      [from, mid, end],
      (q) => 0.06 * s * (1 - q * 0.75),
      4,
      grey,
      () => 0,
      0.02,
    )
  }
}

function boulder(g: PlantGeo, rng: Rng, x: number, y: number, z: number, s: number): void {
  const n = 1 + (rng.next() < 0.4 ? 1 + Math.floor(rng.next() * 2) : 0)
  const col = ROCKS[Math.floor(rng.next() * ROCKS.length)] ?? C(0x9a_5a_3e)
  for (let i = 0; i < n; i++) {
    const r = (0.4 + rng.next() * 0.9) * s * (i === 0 ? 1 : 0.55)
    const ox = i === 0 ? 0 : (rng.next() - 0.5) * r * 3
    const oz = i === 0 ? 0 : (rng.next() - 0.5) * r * 3
    const ry = r * (0.5 + rng.next() * 0.35)
    // half-buried: the ground plane cuts the lower half away
    g.rock(
      new Vector3(x + ox, y + ry * 0.35, z + oz),
      new Vector3(r, ry, r * (0.75 + rng.next() * 0.4)),
      jitter(col, rng, 0.15),
      rng,
      rng.next() * 6,
    )
  }
}

function plant(g: PlantGeo, p: Plant, y: number): void {
  const rng = new Rng(p.seed)
  switch (p.kind) {
    case 'saguaro':
      saguaro(g, rng, p.x, y, p.z, p.s, p.lod)
      break
    case 'joshua':
      joshua(g, rng, p.x, y, p.z, p.s, p.lod)
      break
    case 'barrel':
      barrel(g, rng, p.x, y, p.z, p.s, p.lod)
      break
    case 'pear':
      pear(g, rng, p.x, y, p.z, p.s)
      break
    case 'cholla':
      cholla(g, rng, p.x, y, p.z, p.s, p.lod)
      break
    case 'ocotillo':
      ocotillo(g, rng, p.x, y, p.z, p.s, p.lod)
      break
    case 'creosote':
    case 'sage':
      shrub(g, rng, p.x, y, p.z, p.s, p.kind, p.lod)
      break
    case 'grass':
      grass(g, rng, p.x, y, p.z, p.s)
      break
    case 'snag':
      snag(g, rng, p.x, y, p.z, p.s)
      break
    case 'boulder':
      boulder(g, rng, p.x, y, p.z, p.s)
      break
    default:
      break
  }
}

// ---------------------------------------------------------------- material

const SWAY_VERT = /* glsl */ `
attribute float sway;
uniform float atmTime;
uniform float atmGust;
uniform vec2 atmGustDir;
`

let shared: MeshStandardMaterial | null = null

/** The one plant material: vertex colour, wind sway, a world-space detail grain, cloud shadows. */
export function floraMaterial(): MeshStandardMaterial {
  if (shared) {
    return shared
  }
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 })
  mat.name = 'flora'
  mat.userData.procedural = true
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    bindAtmos(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SWAY_VERT}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float ph = dot(transformed.xz, vec2(0.37, 0.23));
  float gust = 0.55 + 0.45 * sin(atmTime * 0.31 + transformed.x * 0.02);
  float w = (sin(atmTime * 1.9 + ph) * 0.55 + sin(atmTime * 3.7 + ph * 1.7) * 0.25 + 0.5) * gust;
  float amp = sway * atmGust * 0.22;
  transformed.xz += atmGustDir * (w * amp);
  transformed.x += sin(atmTime * 5.3 + ph * 3.0) * amp * 0.12;
  transformed.y -= amp * amp * w * 0.6;
}`,
      )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
  // fine grain: spines, bark fibres and leaf speckle, stretched along the stems (world y)
  vec3 wp = vAtmW;
  float g1 = atmNoise(vec2(wp.x * 23.0 + wp.z * 17.0, wp.y * 4.0));
  float g2 = atmNoise(wp.xz * 41.0 + wp.y * 29.0);
  diffuseColor.rgb *= 0.84 + 0.22 * g1 + 0.12 * g2;
}`,
    )
  }
  mat.customProgramCacheKey = () => 'ow-flora'
  withCloudShadow(mat)
  shared = mat
  return mat
}

// ---------------------------------------------------------------- scatter and build

/** Footprint radius per species, m (a plant is seated at the lowest ground under it). */
const FOOT: Record<PlantKind, number> = {
  saguaro: 0.45,
  joshua: 0.4,
  barrel: 0.45,
  pear: 1,
  cholla: 0.3,
  ocotillo: 0.4,
  creosote: 1.4,
  sage: 0.9,
  grass: 0.3,
  snag: 0.35,
  boulder: 2,
}

export interface FloraOpts {
  /** Ground height at (x, z). */
  heightAt: (x: number, z: number) => number
  /** Grid size of the merged chunks, m. */
  chunk: number
  /** Overrides the grid: which chunk a plant at (x, z) merges into. */
  chunkKey?: (x: number, z: number) => string
  /** Centre the impostors are split round (four quadrant meshes). */
  centre?: { x: number; z: number }
  /** Chunks whose centre is within this of `near` cast shadows. */
  shadowNear?: { x: number; z: number; r: number }
}

/**
 * Drop any plant whose footprint overlaps one kept before it (the scatter passes are separate, so
 * two clumps can land on one spot): no two plants grow through each other.
 */
function spaced(plants: readonly Plant[]): Plant[] {
  const cell = 4
  const grid = new Map<string, Plant[]>()
  const out: Plant[] = []
  for (const p of plants) {
    const r = FOOT[p.kind] * p.s
    const ix = Math.floor(p.x / cell)
    const iz = Math.floor(p.z / cell)
    let clash = false
    for (let i = -1; i <= 1 && !clash; i++) {
      for (let j = -1; j <= 1 && !clash; j++) {
        for (const q of grid.get(`${ix + i},${iz + j}`) ?? []) {
          if (Math.hypot(q.x - p.x, q.z - p.z) < (r + FOOT[q.kind] * q.s) * 0.7) {
            clash = true
            break
          }
        }
      }
    }
    if (clash) {
      continue
    }
    out.push(p)
    const k = `${ix},${iz}`
    const list = grid.get(k)
    if (list) {
      list.push(p)
    } else {
      grid.set(k, [p])
    }
  }
  return out
}

/** Bake the plants into merged, chunked, static meshes under one group. */
export function buildFlora(plants: readonly Plant[], opts: FloraOpts): Group {
  const root = new Group()
  root.name = 'flora'
  markRole(root, ROLE.Flora)
  const chunks = new Map<string, PlantGeo>()
  const far = new Map<string, Plant[]>()
  const ctr = opts.centre ?? { x: 0, z: 0 }
  for (const p of spaced(plants)) {
    if (p.imp) {
      const q = `${p.x < ctr.x ? 'w' : 'e'}${p.z < ctr.z ? 'n' : 's'}`
      const list = far.get(q)
      if (list) {
        list.push(p)
      } else {
        far.set(q, [p])
      }
      continue
    }
    const key =
      opts.chunkKey?.(p.x, p.z) ?? `${Math.floor(p.x / opts.chunk)},${Math.floor(p.z / opts.chunk)}`
    let g = chunks.get(key)
    if (!g) {
      g = new PlantGeo()
      chunks.set(key, g)
    }
    // seat it at the lowest ground under its footprint (on a slope the uphill side buries)
    const h = opts.heightAt
    const r = FOOT[p.kind] * p.s
    const y = Math.min(
      h(p.x, p.z),
      h(p.x + r, p.z),
      h(p.x - r, p.z),
      h(p.x, p.z + r),
      h(p.x, p.z - r),
    )
    plant(g, p, y - (y > 0.01 ? 0.03 : 0))
  }
  const mat = floraMaterial()
  for (const [key, g] of chunks) {
    const geo = g.build()
    if (!geo) {
      continue
    }
    releaseAfterUpload(geo)
    const m = new Mesh(geo, mat)
    m.name = 'flora'
    markRole(m, ROLE.Flora)
    m.userData.chunk = key
    m.matrixAutoUpdate = false
    m.receiveShadow = true
    const sn = opts.shadowNear
    const c = geo.boundingSphere?.center
    m.castShadow = Boolean(sn && c && Math.hypot(c.x - sn.x, c.z - sn.z) < sn.r)
    root.add(m)
  }
  for (const list of far.values()) {
    const m = buildImpostors(list, opts.heightAt)
    if (m) {
      root.add(m)
    }
  }
  return root
}

/**
 * Seeded clumped scatter (Poisson-ish inside clumps, clumps placed at random): `clumps` centres in
 * the box, each with a handful of points spread round it, kept `minGap` apart and wherever
 * `accept` allows.
 */
export function clumpScatter(
  rng: Rng,
  box: { x0: number; z0: number; x1: number; z1: number },
  clumps: number,
  perClump: [number, number],
  radius: number,
  minGap: number,
  accept: (x: number, z: number) => boolean,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  const cell = Math.max(0.5, minGap)
  const grid = new Map<string, { x: number; z: number }[]>()
  const near = (x: number, z: number) => {
    const ix = Math.floor(x / cell)
    const iz = Math.floor(z / cell)
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const q of grid.get(`${ix + i},${iz + j}`) ?? []) {
          if (Math.hypot(q.x - x, q.z - z) < minGap) {
            return true
          }
        }
      }
    }
    return false
  }
  for (let c = 0; c < clumps; c++) {
    const cx = box.x0 + rng.next() * (box.x1 - box.x0)
    const cz = box.z0 + rng.next() * (box.z1 - box.z0)
    const n = perClump[0] + Math.floor(rng.next() * (perClump[1] - perClump[0] + 1))
    for (let i = 0; i < n; i++) {
      // denser toward the clump's heart
      const r = radius * Math.sqrt(rng.next()) * (0.3 + 0.7 * rng.next())
      const a = rng.next() * Math.PI * 2
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      if (!accept(x, z) || near(x, z)) {
        continue
      }
      const p = { x, z }
      out.push(p)
      const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`
      const list = grid.get(k)
      if (list) {
        list.push(p)
      } else {
        grid.set(k, [p])
      }
    }
  }
  return out
}

/** Pick a species from weights. */
export function pickKind(rng: Rng, weights: readonly (readonly [PlantKind, number])[]): PlantKind {
  const total = weights.reduce((s, [, w]) => s + w, 0)
  let r = rng.next() * total
  for (const [k, w] of weights) {
    r -= w
    if (r <= 0) {
      return k
    }
  }
  return weights[0]?.[0] ?? 'grass'
}

/** Instance-count multiplier per quality tier. */
export function floraDensity(tier: string): number {
  switch (tier) {
    case 'high':
      return 1
    case 'medium':
      return 0.85
    case 'floor':
      return 0.45
    default:
      return 0.3
  }
}
