// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one flat pass over the triangles
/**
 * Far-distance stand-ins for kit props: vertex clustering (every vertex snapped to the average of
 * its cell in a coarse grid, collapsed triangles dropped). Cheap to build at load, no library,
 * and it keeps a prop's silhouette and its texture coordinates closely enough for 40 m+ in the
 * haze: a 432-triangle rock comes out at a few dozen. Cached per prop def.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import type { PropDef } from '../../scene/props.ts'

const cache = new WeakMap<PropDef, Map<number, PropDef>>()

function cluster(src: BufferGeometry, cell: number): BufferGeometry {
  const pos = src.getAttribute('position')
  const idx = src.index
  const n = pos.count
  const rep = new Int32Array(n)
  const cells = new Map<string, number>()
  const sum = new Map<number, [number, number, number, number]>()
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
    let r = cells.get(k)
    if (r === undefined) {
      r = i
      cells.set(k, i)
      sum.set(i, [0, 0, 0, 0])
    }
    rep[i] = r
    const s = sum.get(r) as [number, number, number, number]
    s[0] += x
    s[1] += y
    s[2] += z
    s[3]++
  }
  const tris: number[] = []
  const triCount = idx ? idx.count / 3 : n / 3
  for (let t = 0; t < triCount; t++) {
    const a = rep[idx ? idx.getX(t * 3) : t * 3] ?? 0
    const b = rep[idx ? idx.getX(t * 3 + 1) : t * 3 + 1] ?? 0
    const c = rep[idx ? idx.getX(t * 3 + 2) : t * 3 + 2] ?? 0
    if (a !== b && b !== c && a !== c) {
      tris.push(a, b, c)
    }
  }
  const out = new BufferGeometry()
  for (const name of Object.keys(src.attributes)) {
    const attr = src.getAttribute(name)
    const size = attr.itemSize
    const arr = new Float32Array(tris.length * size)
    for (const [j, v] of tris.entries()) {
      for (let c = 0; c < size; c++) {
        arr[j * size + c] = attr.getComponent(v, c)
      }
      if (name === 'position') {
        const s = sum.get(v) as [number, number, number, number]
        arr[j * 3] = s[0] / s[3]
        arr[j * 3 + 1] = s[1] / s[3]
        arr[j * 3 + 2] = s[2] / s[3]
      }
    }
    out.setAttribute(name, new BufferAttribute(arr, size))
  }
  if (src.getAttribute('normal')) {
    out.computeVertexNormals()
  }
  out.computeBoundingSphere()
  return out
}

/** A coarse copy of a prop: vertices clustered on a `cell`-metre grid (in the def's own units). */
export function farDef(def: PropDef, cell: number): PropDef {
  const byCell = cache.get(def) ?? new Map<number, PropDef>()
  cache.set(def, byCell)
  const hit = byCell.get(cell)
  if (hit) {
    return hit
  }
  const lod: PropDef = {
    name: def.name,
    parts: def.parts.map((p) => ({ geometry: cluster(p.geometry, cell), material: p.material })),
    size: def.size,
  }
  byCell.set(cell, lod)
  return lod
}

/** Triangles in a def (for the budget notes). */
export function defTriangles(def: PropDef): number {
  let t = 0
  for (const p of def.parts) {
    const g = p.geometry
    t += (g.index ? g.index.count : g.getAttribute('position').count) / 3
  }
  return t
}
