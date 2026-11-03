// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * Geometry plumbing for the clock tower: a per-cell builder for the masonry atlas, arbitrary
 * three.js geometry folded into it with world-planar UVs, and the iron parts with their spin
 * attributes (scene/civic.ts turns them in the vertex shader).
 */
import {
  type BufferGeometry,
  Color,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Matrix4,
  Path,
  Shape,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CIVIC_CELL_U, CIVIC_INDEX, CIVIC_SETS, type CivicCell } from './civic-atlas.ts'
import { GeoBuilder } from './geo.ts'

const UP = new Vector3(0, 1, 0)

/** A wall frame: local x along the wall (right-handed), y up, z into the wall. */
export function wallFrame(origin: Vector3, outward: Vector3): Matrix4 {
  const right = new Vector3().crossVectors(outward, UP).normalize()
  const inward = outward.clone().negate()
  return new Matrix4().makeBasis(right, UP, inward).setPosition(origin)
}

/** A dial frame: local x toward three o'clock, y toward twelve, z out of the face. */
export function dialFrame(origin: Vector3, outward: Vector3): Matrix4 {
  const right = new Vector3().crossVectors(UP, outward).normalize()
  return new Matrix4().makeBasis(right, UP, outward).setPosition(origin)
}

function nonIndexed(g: BufferGeometry): BufferGeometry {
  return g.index ? g.toNonIndexed() : g
}

/** Masonry for the civic atlas: one GeoBuilder per cell, plus free-form pieces. */
export class Masonry {
  private readonly cells: GeoBuilder[]
  private readonly extra: { geo: BufferGeometry; cell: number; color: number }[] = []

  constructor() {
    this.cells = CIVIC_SETS.map((s) => new GeoBuilder(s.metres))
  }

  /** The builder for one cell (boxes, quads, triangles with world-planar UVs). */
  cell(c: CivicCell): GeoBuilder {
    return this.cells[CIVIC_INDEX[c]] as GeoBuilder
  }

  /** Any world-space geometry (normals kept), UV'd like GeoBuilder per triangle. */
  add(c: CivicCell, geo: BufferGeometry, color: number): void {
    this.extra.push({ geo: nonIndexed(geo), cell: CIVIC_INDEX[c], color })
  }

  private planar(e: { geo: BufferGeometry; cell: number; color: number }): BufferGeometry {
    const g = e.geo
    const pos = g.getAttribute('position')
    const n = pos.count
    const tile = CIVIC_SETS[e.cell]?.metres ?? 1
    const uv = new Float32Array(n * 2)
    const col = new Float32Array(n * 3)
    const c = new Color(e.color)
    const a = new Vector3()
    const b = new Vector3()
    const p = new Vector3()
    const f = new Vector3()
    for (let t = 0; t < n; t += 3) {
      p.fromBufferAttribute(pos, t)
      a.fromBufferAttribute(pos, t + 1).sub(p)
      b.fromBufferAttribute(pos, t + 2).sub(p)
      f.crossVectors(a, b)
      const ax = Math.abs(f.x)
      const ay = Math.abs(f.y)
      const az = Math.abs(f.z)
      for (let k = t; k < t + 3; k++) {
        p.fromBufferAttribute(pos, k)
        let u = p.x
        let v = p.y
        if (ay >= ax && ay >= az) {
          v = p.z
        } else if (ax >= az) {
          u = p.z
        }
        uv[k * 2] = u / tile
        uv[k * 2 + 1] = v / tile
        col[k * 3] = c.r
        col[k * 3 + 1] = c.g
        col[k * 3 + 2] = c.b
      }
    }
    if (!g.getAttribute('normal')) {
      g.computeVertexNormals()
    }
    const out = g.clone()
    for (const name of Object.keys(out.attributes)) {
      if (name !== 'position' && name !== 'normal') {
        out.deleteAttribute(name)
      }
    }
    out.setAttribute('uv', new Float32BufferAttribute(uv, 2))
    out.setAttribute('color', new Float32BufferAttribute(col, 3))
    return out
  }

  /** One geometry: every cell's pieces, U offset into their atlas cell. */
  build(shade?: (p: Vector3, n: Vector3) => number): BufferGeometry | null {
    const parts: BufferGeometry[] = []
    const offset = (g: BufferGeometry, cell: number) => {
      const uv = g.getAttribute('uv')
      for (let i = 0; i < uv.count; i++) {
        uv.setX(i, uv.getX(i) + CIVIC_CELL_U / 2 + cell * CIVIC_CELL_U)
      }
      parts.push(g)
    }
    this.cells.forEach((b, i) => {
      if (!b.empty) {
        offset(b.build(), i)
      }
    })
    for (const e of this.extra) {
      offset(this.planar(e), e.cell)
    }
    const geo = parts.length > 0 ? mergeGeometries(parts, false) : null
    if (geo && shade) {
      shadeColors(geo, shade)
    }
    geo?.computeBoundingSphere()
    return geo
  }
}

/** Multiply vertex colours by a baked occlusion term. */
export function shadeColors(geo: BufferGeometry, fn: (p: Vector3, n: Vector3) => number): void {
  const pos = geo.getAttribute('position')
  const nor = geo.getAttribute('normal')
  const col = geo.getAttribute('color')
  const p = new Vector3()
  const n = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    n.fromBufferAttribute(nor, i)
    const k = fn(p, n)
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k)
  }
}

/**
 * A wall panel with a round-arched opening, in a wall frame (scene units). The panel spans
 * x 0..w, y 0..h; the opening is `ow` wide, centred, from `sill` up to its springing line
 * `spring`, then a semicircle.
 */
export function archPanel(
  w: number,
  h: number,
  thick: number,
  ow: number,
  sill: number,
  spring: number,
): ExtrudeGeometry {
  const s = new Shape()
  s.moveTo(0, 0)
  s.lineTo(w, 0)
  s.lineTo(w, h)
  s.lineTo(0, h)
  s.closePath()
  const r = ow / 2
  const cx = w / 2
  const hole = new Path()
  hole.moveTo(cx - r, sill)
  hole.lineTo(cx + r, sill)
  hole.lineTo(cx + r, spring)
  hole.absarc(cx, spring, r, 0, Math.PI, false)
  hole.lineTo(cx - r, sill)
  s.holes.push(hole)
  return new ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 14 })
}

/** A half-annulus (an archivolt) in a wall frame, centred on (cx, spring). */
export function archRing(
  cx: number,
  spring: number,
  r0: number,
  r1: number,
  depth: number,
): ExtrudeGeometry {
  const s = new Shape()
  s.moveTo(cx + r1, spring)
  s.absarc(cx, spring, r1, 0, Math.PI, false)
  s.lineTo(cx - r0, spring)
  s.absarc(cx, spring, r0, Math.PI, 0, true)
  s.closePath()
  return new ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 14 })
}

/** A flat, extruded outline (hands, vane), local xy, extruded +z by `depth`. */
export function plate(points: [number, number][], depth: number, holes: Path[] = []) {
  const s = new Shape()
  const [first, ...rest] = points
  if (first) {
    s.moveTo(first[0], first[1])
  }
  for (const [x, y] of rest) {
    s.lineTo(x, y)
  }
  s.closePath()
  s.holes.push(...holes)
  return new ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 8 })
}

/** One iron part: colour plus the spin attributes (kind 0 never moves). */
export function ironPart(
  geo: BufferGeometry,
  color: number,
  kind = 0,
  pivot = new Vector3(),
  axis = new Vector3(),
): BufferGeometry {
  const g = nonIndexed(geo)
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') {
      g.deleteAttribute(name)
    }
  }
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  const spin = new Float32Array(n * 4)
  const ax = new Float32Array(n * 3)
  const c = new Color(color)
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3)
    spin.set([pivot.x, pivot.y, pivot.z, kind], i * 4)
    ax.set([axis.x, axis.y, axis.z], i * 3)
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  g.setAttribute('owSpin', new Float32BufferAttribute(spin, 4))
  g.setAttribute('owAxis', new Float32BufferAttribute(ax, 3))
  return g
}
