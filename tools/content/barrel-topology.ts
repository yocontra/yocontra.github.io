/** Conform only donor barrel UV cuts before constructing solid fragment boundaries. */
import { Vec3 } from 'playcanvas'
export type V3 = [number, number, number]
export type V2 = [number, number]
export interface BarrelVertex {
  p: V3
  uv: V2
  color: V3
  smooth: V3
}
export type BarrelTriangle = [BarrelVertex, BarrelVertex, BarrelVertex]
export const barrelPointKey = (v: V3) => v.map((n) => Math.round(n * 1e6)).join(':')
export const cloneBarrelVertex = (v: BarrelVertex): BarrelVertex => ({
  p: [...v.p],
  uv: [...v.uv],
  color: [...v.color],
  smooth: [...v.smooth],
})
export function interpolateBarrel(a: BarrelVertex, b: BarrelVertex, t: number): BarrelVertex {
  const values = (x: number[], y: number[]) => x.map((v, i) => v + ((y[i] ?? 0) - v) * t)
  return {
    p: values(a.p, b.p) as V3,
    uv: values(a.uv, b.uv) as V2,
    color: values(a.color, b.color) as V3,
    smooth: values(a.smooth, b.smooth) as V3,
  }
}
function edgeCuts(a: BarrelVertex, b: BarrelVertex, points: Iterable<V3>) {
  const edge = new Vec3(...b.p).sub(new Vec3(...a.p))
  const length = edge.lengthSq()
  if (length < 1e-16) {
    throw new Error('Degenerate source edge')
  }
  const cuts: { p: V3; t: number }[] = []
  for (const p of points) {
    const delta = new Vec3(...p).sub(new Vec3(...a.p))
    const t = delta.dot(edge) / length
    if (t <= 1e-7 || t >= 1 - 1e-7) {
      continue
    }
    const distance = delta.sub(edge.clone().mulScalar(t)).lengthSq()
    if (distance < 1e-14) {
      cuts.push({ p, t })
    }
  }
  cuts.sort((left, right) => left.t - right.t)
  return cuts
}
/** Two imported cap triangles are only roundoff-width. Contract their middle point onto the edge. */
function collapseLineFaces(source: BarrelTriangle[]): BarrelTriangle[] {
  return source.filter((tri) => {
    const candidates = tri
      .map((vertex, i) => {
        const b = tri[(i + 1) % 3]
        const c = tri[(i + 2) % 3]
        if (!(b && c)) {
          throw new Error('Invalid source face')
        }
        const edge = new Vec3(...b.p).sub(new Vec3(...vertex.p))
        return { a: vertex, b, c, edge, length: edge.lengthSq() }
      })
      .sort((left, right) => right.length - left.length)
    const longest = candidates[0]
    if (!longest || longest.length < 1e-12) {
      throw new Error('Degenerate source feature')
    }
    const { a, c, edge, length } = longest
    const delta = new Vec3(...c.p).sub(new Vec3(...a.p))
    const t = delta.dot(edge) / length
    const projection = new Vec3(...a.p).add(edge.mulScalar(t))
    if (t > 0 && t < 1 && projection.distance(new Vec3(...c.p)) < 1e-7) {
      c.p[0] = projection.x
      c.p[1] = projection.y
      c.p[2] = projection.z
      return false
    }
    return true
  })
}
/** Source UV seams can cut one side of a shared edge. Split its other side at the same 3D point. */
export function conformBarrel(triangles: BarrelTriangle[]): BarrelTriangle[] {
  const points = new Map<string, V3>()
  const source = triangles.map(
    (tri) =>
      tri.map((v) => {
        const copy = cloneBarrelVertex(v)
        const id = barrelPointKey(v.p)
        const point = points.get(id) ?? ([...v.p] as V3)
        points.set(id, point)
        copy.p = point
        return copy
      }) as BarrelTriangle,
  )
  const result: BarrelTriangle[] = []
  for (const tri of collapseLineFaces(source)) {
    const border: BarrelVertex[] = []
    let split = false
    for (const [i, a] of tri.entries()) {
      const b = tri[(i + 1) % 3]
      if (!b) {
        throw new Error('Invalid source triangle')
      }
      border.push(a)
      const cuts = edgeCuts(a, b, points.values())
      for (const cut of cuts) {
        const vertex = interpolateBarrel(a, b, cut.t)
        vertex.p = cut.p
        border.push(vertex)
        split = true
      }
    }
    if (!split) {
      result.push(tri)
      continue
    }
    const center = interpolateBarrel(tri[0], interpolateBarrel(tri[1], tri[2], 0.5), 2 / 3)
    for (const [i, a] of border.entries()) {
      const b = border[(i + 1) % border.length]
      if (!b) {
        throw new Error('Invalid split boundary')
      }
      result.push([cloneBarrelVertex(center), cloneBarrelVertex(a), cloneBarrelVertex(b)])
    }
  }
  return result
}

/** One stave surface, excluding donor rim flecks that touch the main patch at only a point. */
export function connectedBarrelPatch(triangles: BarrelTriangle[]): BarrelTriangle[] {
  const parents = triangles.map((_, i) => i)
  const find = (i: number): number => {
    const p = parents[i]
    if (p === undefined) {
      throw new Error('Invalid patch')
    }
    return p === i ? i : find(p)
  }
  const edges = new Map<string, number>()
  for (const [i, tri] of triangles.entries()) {
    for (const [j, a] of tri.entries()) {
      const b = tri[(j + 1) % 3]
      if (!b) {
        throw new Error('Invalid patch triangle')
      }
      const id = [barrelPointKey(a.p), barrelPointKey(b.p)]
        .sort((x, y) => x.localeCompare(y))
        .join('|')
      const other = edges.get(id)
      if (other === undefined) {
        edges.set(id, i)
      } else {
        parents[find(i)] = find(other)
      }
    }
  }
  const groups = new Map<number, BarrelTriangle[]>()
  for (const [i, tri] of triangles.entries()) {
    const root = find(i)
    const group = groups.get(root) ?? []
    group.push(tri)
    groups.set(root, group)
  }
  const area = (group: BarrelTriangle[]) =>
    group.reduce(
      (sum, [a, b, c]) =>
        sum +
        new Vec3()
          .cross(new Vec3(...b.p).sub(new Vec3(...a.p)), new Vec3(...c.p).sub(new Vec3(...a.p)))
          .length(),
      0,
    )
  const largest = [...groups.values()].sort((a, b) => area(b) - area(a))[0]
  if (!largest) {
    throw new Error('Missing connected timber surface')
  }
  return largest
}
