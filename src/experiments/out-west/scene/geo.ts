// biome-ignore-all lint/complexity/useMaxParams: geometry/audio builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
import { BufferGeometry, Color, Float32BufferAttribute, Vector3 } from 'three'

/**
 * Accumulates flat-shaded quads/triangles with world-scale UVs and vertex
 * colours, so a whole street of false fronts merges into one draw call per
 * material.
 */
export class GeoBuilder {
  private readonly pos: number[] = []
  private readonly nor: number[] = []
  private readonly uv: number[] = []
  private readonly col: number[] = []
  /** World metres per texture repeat. */
  tile: number

  constructor(tile = 2) {
    this.tile = tile
  }

  private static readonly a = new Vector3()
  private static readonly b = new Vector3()
  private static readonly n = new Vector3()
  private static readonly c = new Color()

  private planarUV(p: Vector3, n: Vector3, rot: boolean): [number, number] {
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)
    let u: number
    let v: number
    if (ay >= ax && ay >= az) {
      u = p.x
      v = p.z
    } else if (ax >= az) {
      u = p.z
      v = p.y
    } else {
      u = p.x
      v = p.y
    }
    if (rot) {
      ;[u, v] = [v, u]
    }
    return [u / this.tile, v / this.tile]
  }

  tri(p0: Vector3, p1: Vector3, p2: Vector3, color: number, rotUV = false): void {
    const n = GeoBuilder.n
      .copy(GeoBuilder.a.subVectors(p1, p0))
      .cross(GeoBuilder.b.subVectors(p2, p0))
      .normalize()
    const c = GeoBuilder.c.set(color)
    for (const p of [p0, p1, p2]) {
      this.pos.push(p.x, p.y, p.z)
      this.nor.push(n.x, n.y, n.z)
      const [u, v] = this.planarUV(p, n, rotUV)
      this.uv.push(u, v)
      this.col.push(c.r, c.g, c.b)
    }
  }

  /** Quad with explicit UVs (0..1 per corner, for signs). */
  quadUV(
    p: [Vector3, Vector3, Vector3, Vector3],
    uvs: [number, number, number, number, number, number, number, number],
    color: number,
  ): void {
    const [p0, p1, p2, p3] = p
    const n = GeoBuilder.n
      .copy(GeoBuilder.a.subVectors(p1, p0))
      .cross(GeoBuilder.b.subVectors(p2, p0))
      .normalize()
    const c = GeoBuilder.c.set(color)
    const order = [0, 1, 2, 0, 2, 3]
    for (const i of order) {
      const q = p[i] as Vector3
      this.pos.push(q.x, q.y, q.z)
      this.nor.push(n.x, n.y, n.z)
      this.uv.push(uvs[i * 2] as number, uvs[i * 2 + 1] as number)
      this.col.push(c.r, c.g, c.b)
    }
    void p3
  }

  quad(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, color: number, rotUV = false): void {
    this.tri(p0, p1, p2, color, rotUV)
    this.tri(p0, p2, p3, color, rotUV)
  }

  /** Axis-aligned box centred at (cx, cy, cz). `skip` omits faces: 'top','bottom','px','nx','pz','nz'. */
  box(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    color: number,
    opts: { skip?: string[]; rotUV?: boolean } = {},
  ): void {
    const x0 = cx - sx / 2
    const x1 = cx + sx / 2
    const y0 = cy - sy / 2
    const y1 = cy + sy / 2
    const z0 = cz - sz / 2
    const z1 = cz + sz / 2
    const s = new Set(opts.skip ?? [])
    const r = opts.rotUV ?? false
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
    if (!s.has('pz')) {
      this.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), color, r)
    }
    if (!s.has('nz')) {
      this.quad(V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0), color, r)
    }
    if (!s.has('px')) {
      this.quad(V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), color, r)
    }
    if (!s.has('nx')) {
      this.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0), color, r)
    }
    if (!s.has('top')) {
      this.quad(V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), V(x0, y1, z0), color, r)
    }
    if (!s.has('bottom')) {
      this.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), color, r)
    }
  }

  /** Gable roof along the given axis over a footprint, ridge height h above y. */
  gable(
    cx: number,
    y: number,
    cz: number,
    sx: number,
    sz: number,
    h: number,
    axis: 'x' | 'z',
    color: number,
    overhang = 0.4,
  ): void {
    const V = (x: number, yy: number, z: number) => new Vector3(x, yy, z)
    const hx = sx / 2 + overhang
    const hz = sz / 2 + overhang
    if (axis === 'z') {
      const a = V(cx - hx, y, cz - hz)
      const b = V(cx - hx, y, cz + hz)
      const c = V(cx, y + h, cz + hz)
      const d = V(cx, y + h, cz - hz)
      const e = V(cx + hx, y, cz + hz)
      const f = V(cx + hx, y, cz - hz)
      this.quad(a, b, c, d, color, true)
      this.quad(e, f, d, c, color, true)
      this.tri(
        V(cx - sx / 2, y, cz + sz / 2),
        V(cx + sx / 2, y, cz + sz / 2),
        V(cx, y + h, cz + sz / 2),
        color,
      )
      this.tri(
        V(cx + sx / 2, y, cz - sz / 2),
        V(cx - sx / 2, y, cz - sz / 2),
        V(cx, y + h, cz - sz / 2),
        color,
      )
    } else {
      const a = V(cx - hx, y, cz + hz)
      const b = V(cx + hx, y, cz + hz)
      const c = V(cx + hx, y + h, cz)
      const d = V(cx - hx, y + h, cz)
      const e = V(cx + hx, y, cz - hz)
      const f = V(cx - hx, y, cz - hz)
      this.quad(a, b, c, d, color, true)
      this.quad(e, f, d, c, color, true)
      this.tri(
        V(cx + sx / 2, y, cz + sz / 2),
        V(cx + sx / 2, y, cz - sz / 2),
        V(cx + sx / 2, y + h, cz),
        color,
      )
      this.tri(
        V(cx - sx / 2, y, cz - sz / 2),
        V(cx - sx / 2, y, cz + sz / 2),
        V(cx - sx / 2, y + h, cz),
        color,
      )
    }
  }

  /** Four-sided pyramid (spire). */
  pyramid(cx: number, y: number, cz: number, s: number, h: number, color: number): void {
    const V = (x: number, yy: number, z: number) => new Vector3(x, yy, z)
    const t = V(cx, y + h, cz)
    const a = V(cx - s / 2, y, cz - s / 2)
    const b = V(cx + s / 2, y, cz - s / 2)
    const c = V(cx + s / 2, y, cz + s / 2)
    const d = V(cx - s / 2, y, cz + s / 2)
    this.tri(d, c, t, color)
    this.tri(c, b, t, color)
    this.tri(b, a, t, color)
    this.tri(a, d, t, color)
  }

  get empty(): boolean {
    return this.pos.length === 0
  }

  build(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}
