/** Explicit finite waistcoat authoring repair; the runtime only consumes native skinned geometry. */
import type { Document, Primitive } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'

interface Range {
  start: number
  count: number
}
interface WaistcoatFit {
  ranges: Range[]
  bone: string
  rearLimit: number
  hemBone: string
  hemStart: number
  hemBlend: number
}
export function fitWaistcoats(doc: Document): void {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const skin = node.getSkin()
    if (!(mesh && skin)) {
      continue
    }
    for (const primitive of mesh.listPrimitives()) {
      const fit = primitive.getExtras().waistcoatFit as WaistcoatFit | undefined
      if (!fit) {
        continue
      }
      const bone = skin.listJoints().findIndex((joint) => joint.getName() === fit.bone)
      if (bone < 0) {
        throw new Error(`Missing authored waistcoat bone ${fit.bone}`)
      }
      const hem = skin.listJoints().findIndex((joint) => joint.getName() === fit.hemBone)
      if (hem < 0) {
        throw new Error(`Missing authored waistcoat hem bone ${fit.hemBone}`)
      }
      fitPrimitive(primitive, fit, bone, hem)
    }
  }
}
function fitPrimitive(primitive: Primitive, fit: WaistcoatFit, bone: number, hem: number): void {
  const positions = primitive.getAttribute('POSITION')
  const joints = primitive.getAttribute('JOINTS_0')
  const weights = primitive.getAttribute('WEIGHTS_0')
  if (!(positions && joints && weights)) {
    throw new Error('Waistcoat requires a complete native skin')
  }
  const vertices = new Set<number>()
  for (const range of fit.ranges) {
    for (let vertex = range.start; vertex < range.start + range.count; vertex++) {
      const point = positions.getElement(vertex, [] as number[])
      positions.setElement(vertex, [
        point[0] ?? 0,
        point[1] ?? 0,
        Math.max(fit.rearLimit, point[2] ?? 0),
      ])
      const torsoWeight = Math.max(0, Math.min(1, ((point[1] ?? 0) - fit.hemStart) / fit.hemBlend))
      joints.setElement(vertex, [hem, bone, 0, 0])
      weights.setElement(vertex, [1 - torsoWeight, torsoWeight, 0, 0])
      vertices.add(vertex)
    }
  }
  fitNormals(primitive, vertices)
}
function fitNormals(primitive: Primitive, vertices: ReadonlySet<number>): void {
  const positions = primitive.getAttribute('POSITION')
  const normals = primitive.getAttribute('NORMAL')
  const indices = primitive.getIndices()
  if (!(positions && normals && indices)) {
    throw new Error('Waistcoat requires indexed surface normals')
  }
  const sums = new Map<number, Vec3>()
  const a = new Vec3()
  const b = new Vec3()
  const c = new Vec3()
  const normal = new Vec3()
  for (let index = 0; index < indices.getCount(); index += 3) {
    const tri = [
      indices.getScalar(index),
      indices.getScalar(index + 1),
      indices.getScalar(index + 2),
    ]
    if (!tri.every((vertex) => vertices.has(vertex))) {
      continue
    }
    a.fromArray(positions.getElement(tri[0] ?? 0, []))
    b.fromArray(positions.getElement(tri[1] ?? 0, [])).sub(a)
    c.fromArray(positions.getElement(tri[2] ?? 0, [])).sub(a)
    normal.cross(b, c)
    for (const vertex of tri) {
      const sum = sums.get(vertex) ?? new Vec3()
      sum.add(normal)
      sums.set(vertex, sum)
    }
  }
  for (const [vertex, sum] of sums) {
    if (sum.lengthSq() > 1e-18) {
      normals.setElement(vertex, sum.normalize().toArray())
    }
  }
}
