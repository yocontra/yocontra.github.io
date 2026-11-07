/** Keep only the vertices actually drawn by a garment, retaining its authored smooth normals. */
import { BufferAttribute, BufferGeometry } from 'three'

export interface Cuff {
  side: 'L' | 'R'
  vertices: number[]
}
export function compactGarment(source: BufferGeometry, triangles: number[]): BufferGeometry {
  const remap = new Map<number, number>()
  for (const vertex of triangles) {
    if (!remap.has(vertex)) {
      remap.set(vertex, remap.size)
    }
  }
  const out = new BufferGeometry()
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const values = new Float32Array(remap.size * attribute.itemSize)
    for (const [old, current] of remap) {
      for (let c = 0; c < attribute.itemSize; c++) {
        values[current * attribute.itemSize + c] = attribute.getComponent(old, c)
      }
    }
    out.setAttribute(name, new BufferAttribute(values, attribute.itemSize))
  }
  out.userData.sourceVertices = [...remap.keys()]
  out.setIndex(triangles.map((vertex) => remap.get(vertex) ?? 0))
  const cuffs = source.userData.cuffs as Cuff[] | undefined
  out.userData.cuffs =
    cuffs?.flatMap((cuff) => {
      const vertices = cuff.vertices.flatMap((vertex) => {
        const index = remap.get(vertex)
        return index === undefined ? [] : [index]
      })
      return vertices.length > 0 ? [{ side: cuff.side, vertices }] : []
    }) ?? []
  return out
}
