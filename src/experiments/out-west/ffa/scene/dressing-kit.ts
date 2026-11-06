// biome-ignore-all lint/complexity/useMaxParams: fitting helpers take positional dimensions, like the builders
/** Kit placement maths for the Frontier dressing pass: seeded jitter, fitting, tiling and colour. */
import { type BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three'
import type { PropDef } from '../../scene/props.ts'
import type { Rect } from '../sim/layout.ts'

/** Deterministic jitter so the town looks the same for everyone. */
export function rand(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10_000) / 10_000
  }
}

/**
 * A prop stretched to fill a ground rect (`w` along x, `d` along z), its long side along the
 * rect's long side, `h` tall (or scaled with its footprint).
 */
export function fitTo(
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
export function cells(
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

export function colorize(g: BufferGeometry, color: number): BufferGeometry {
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
