// biome-ignore-all lint/style/noMagicNumbers: position quantisation and vector component offsets
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one flat pass over flat arrays (faces, corners, vertices)
/**
 * Smooth vertex normals with a crease angle, in place, keeping the index buffer (so the pieces
 * still merge, skin and simplify as before).
 *
 * `computeVertexNormals` only averages across triangles that share a vertex *index*. Geometry
 * split along seams (a poncho's duplicated ring at each stripe, a UV seam, a model exported
 * flat-shaded with its own vertices per face) shades as hard facets there. Here each vertex
 * takes the area-weighted normals of every triangle touching its *position* whose own normal is
 * within `creaseDeg` of the vertex's: seams and facets smooth over, real creases (a hem folded
 * back, a lapel edge, the corner of a gun's frame) stay sharp, and a two-sided shell's inner and
 * outer faces (opposite normals at the same place) never mix.
 */
import { BufferAttribute, type BufferGeometry } from 'three'

const key = (p: ArrayLike<number>, i: number): string =>
  `${Math.round((p[i * 3] ?? 0) * 1e4)},${Math.round((p[i * 3 + 1] ?? 0) * 1e4)},${Math.round((p[i * 3 + 2] ?? 0) * 1e4)}`

/** Crease-angle normals on `g`, written into a fresh Float32 `normal` attribute. */
export function creaseNormals(g: BufferGeometry, creaseDeg = 50, usedOnly?: Uint32Array): void {
  const posA = g.getAttribute('position')
  const n = posA.count
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = posA.getX(i)
    pos[i * 3 + 1] = posA.getY(i)
    pos[i * 3 + 2] = posA.getZ(i)
  }
  const idx = usedOnly ?? (g.index ? Uint32Array.from(g.index.array) : null)
  const triCount = idx ? idx.length / 3 : n / 3
  const corner = (t: number, c: number): number => (idx ? (idx[t * 3 + c] ?? 0) : t * 3 + c)
  // area-weighted face normals
  const face = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const a = corner(t, 0) * 3
    const b = corner(t, 1) * 3
    const c = corner(t, 2) * 3
    const ux = (pos[b] ?? 0) - (pos[a] ?? 0)
    const uy = (pos[b + 1] ?? 0) - (pos[a + 1] ?? 0)
    const uz = (pos[b + 2] ?? 0) - (pos[a + 2] ?? 0)
    const vx = (pos[c] ?? 0) - (pos[a] ?? 0)
    const vy = (pos[c + 1] ?? 0) - (pos[a + 1] ?? 0)
    const vz = (pos[c + 2] ?? 0) - (pos[a + 2] ?? 0)
    face[t * 3] = uy * vz - uz * vy
    face[t * 3 + 1] = uz * vx - ux * vz
    face[t * 3 + 2] = ux * vy - uy * vx
  }
  // each vertex's own normal (its own triangles) and the triangles at each position
  const own = new Float32Array(n * 3)
  const at = new Map<string, number[]>()
  const keys: string[] = new Array<string>(n)
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = corner(t, c)
      own[v * 3] = (own[v * 3] ?? 0) + (face[t * 3] ?? 0)
      own[v * 3 + 1] = (own[v * 3 + 1] ?? 0) + (face[t * 3 + 1] ?? 0)
      own[v * 3 + 2] = (own[v * 3 + 2] ?? 0) + (face[t * 3 + 2] ?? 0)
      keys[v] ??= key(pos, v)
      const k = keys[v] as string
      const list = at.get(k)
      if (list) {
        list.push(t)
      } else {
        at.set(k, [t])
      }
    }
  }
  const cos = Math.cos((creaseDeg * Math.PI) / 180)
  const prev = g.getAttribute('normal')
  const out = new Float32Array(n * 3)
  for (let v = 0; v < n; v++) {
    const ox = own[v * 3] ?? 0
    const oy = own[v * 3 + 1] ?? 0
    const oz = own[v * 3 + 2] ?? 0
    const ol = Math.hypot(ox, oy, oz)
    const k = keys[v]
    if (!(ol > 1e-20 && k)) {
      // unused by these triangles: keep what it had
      out[v * 3] = prev ? prev.getX(v) : 0
      out[v * 3 + 1] = prev ? prev.getY(v) : 1
      out[v * 3 + 2] = prev ? prev.getZ(v) : 0
      continue
    }
    let sx = 0
    let sy = 0
    let sz = 0
    // a triangle counts once per position even when two of its corners share it (degenerate)
    for (const t of new Set(at.get(k))) {
      const fx = face[t * 3] ?? 0
      const fy = face[t * 3 + 1] ?? 0
      const fz = face[t * 3 + 2] ?? 0
      const fl = Math.hypot(fx, fy, fz)
      if (fl > 1e-20 && (fx * ox + fy * oy + fz * oz) / (fl * ol) > cos) {
        sx += fx
        sy += fy
        sz += fz
      }
    }
    const sl = Math.hypot(sx, sy, sz) || 1
    out[v * 3] = sx / sl
    out[v * 3 + 1] = sy / sl
    out[v * 3 + 2] = sz / sl
  }
  g.setAttribute('normal', new BufferAttribute(out, 3))
}
