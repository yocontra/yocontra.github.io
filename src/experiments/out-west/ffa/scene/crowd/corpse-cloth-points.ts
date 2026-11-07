/** Immutable garment skin influences; split UV/normal vertices share one exact contact query. */
import { type BufferGeometry, Matrix4, type SkinnedMesh, Vector3 } from 'three'
export interface ClothRange {
  start: number
  count: number
}
interface ClothInfluence {
  bone: number
  x: number
  y: number
  z: number
  w: number
}
interface ClothPoint {
  vertices: number[]
  influences: ClothInfluence[]
}
export interface ClothPoints {
  count: number
  vertexStarts: Uint32Array
  vertices: Uint32Array
  influenceStarts: Uint32Array
  bones: Uint16Array
  coefficients: Float64Array
}
const cache = new WeakMap<BufferGeometry, ClothPoints>()
const EMPTY = packPoints([])

export function clothPoints(mesh: SkinnedMesh, full: BufferGeometry): ClothPoints {
  const cached = cache.get(full)
  if (cached) {
    return cached
  }
  const ranges = full.userData.clothRanges as ClothRange[] | undefined
  if (!ranges?.length) {
    return EMPTY
  }
  const position = full.getAttribute('position')
  const indices = full.getAttribute('skinIndex')
  const weights = full.getAttribute('skinWeight')
  const bind = mesh.skeleton.boneInverses.map((inverse) =>
    new Matrix4().multiplyMatrices(inverse, mesh.bindMatrix),
  )
  const groups = new Map<string, ClothPoint>()
  const point = new Vector3()
  for (const range of ranges) {
    for (let vertex = range.start; vertex < range.start + range.count; vertex++) {
      const x = position.getX(vertex)
      const y = position.getY(vertex)
      const z = position.getZ(vertex)
      const components = [x, y, z]
      for (let slot = 0; slot < 4; slot++) {
        components.push(indices.getComponent(vertex, slot), weights.getComponent(vertex, slot))
      }
      const key = components.join(',')
      const group = groups.get(key)
      if (group) {
        group.vertices.push(vertex)
        continue
      }
      const influences: ClothInfluence[] = []
      for (let slot = 0; slot < 4; slot++) {
        const w = weights.getComponent(vertex, slot)
        const bone = indices.getComponent(vertex, slot)
        const matrix = bind[bone]
        if (w <= 0 || !matrix) {
          continue
        }
        point.set(x, y, z).applyMatrix4(matrix).multiplyScalar(w)
        influences.push({ bone, x: point.x, y: point.y, z: point.z, w })
      }
      groups.set(key, { vertices: [vertex], influences })
    }
  }
  const points = packPoints([...groups.values()])
  cache.set(full, points)
  return points
}

function packPoints(points: ClothPoint[]): ClothPoints {
  const vertexStarts = new Uint32Array(points.length + 1)
  const influenceStarts = new Uint32Array(points.length + 1)
  const vertices: number[] = []
  const bones: number[] = []
  const coefficients: number[] = []
  for (const [index, point] of points.entries()) {
    vertexStarts[index] = vertices.length
    influenceStarts[index] = bones.length
    vertices.push(...point.vertices)
    for (const influence of point.influences) {
      bones.push(influence.bone)
      coefficients.push(influence.x, influence.y, influence.z, influence.w)
    }
  }
  vertexStarts[points.length] = vertices.length
  influenceStarts[points.length] = bones.length
  return {
    count: points.length,
    vertexStarts,
    vertices: new Uint32Array(vertices),
    influenceStarts,
    bones: new Uint16Array(bones),
    coefficients: new Float64Array(coefficients),
  }
}
