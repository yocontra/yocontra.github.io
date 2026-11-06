// biome-ignore-all lint/complexity/useMaxParams: geometry helpers take positional vectors and radii
/** Plant geometry: the indexed, vertex-coloured mesh builder used by the flora chunks. */
import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  Float32BufferAttribute,
  Uint8BufferAttribute,
  Uint32BufferAttribute,
  Vector3,
} from 'three'
import type { Rng } from '../ffa/sim/rng.ts'

const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpN = new Vector3()

export class PlantGeo {
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
export const OCTA_DIRS: Vector3[] = []
export const OCTA_TRIS: [number, number, number][] = []
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
export const ICO_VERTS: Vector3[] = []
export const ICO_TRIS: [number, number, number][] = [
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
