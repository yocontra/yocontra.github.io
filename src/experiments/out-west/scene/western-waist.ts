/** A tucked shirt surrounds the actual trouser waist without mirroring its rear curve in front. */
import type { Body } from './fit.ts'
import { SLOT } from './roles.ts'

type Point = readonly [number, number]
interface Shape {
  rx: number
  rz: number
  cx: number
  cz: number
}

export function waistOutline(body: Body, shape: Shape, y: number, tucked: boolean): Point[] {
  const ring = Array.from({ length: 32 }, (_, i): Point => {
    const angle = (i / 32) * Math.PI * 2
    return [shape.cx + Math.sin(angle) * shape.rx, shape.cz + Math.cos(angle) * shape.rz]
  })
  if (!tucked) {
    return ring
  }
  const points = [...ring]
  for (const sample of body.samples) {
    if (sample.slot === SLOT.Pants && Math.abs(sample.p.y - y) < 0.035) {
      const x = sample.p.x - shape.cx
      const z = sample.p.z - shape.cz
      const ease = 1 + 0.006 / Math.max(0.01, Math.hypot(x, z))
      points.push([shape.cx + x * ease, shape.cz + z * ease])
    }
  }
  // Intersect support lines rather than sampling radial intersections: joining sampled rays
  // cuts across sharp trouser corners, exposing small denim triangles through the hem.
  return ring.map((_, i): Point => {
    const angle = (i / 32) * Math.PI * 2
    const a: Point = [Math.sin(angle - Math.PI / 32), Math.cos(angle - Math.PI / 32)]
    const b: Point = [Math.sin(angle + Math.PI / 32), Math.cos(angle + Math.PI / 32)]
    const ha = Math.max(...points.map((p) => p[0] * a[0] + p[1] * a[1]))
    const hb = Math.max(...points.map((p) => p[0] * b[0] + p[1] * b[1]))
    const determinant = a[0] * b[1] - b[0] * a[1]
    return [(ha * b[1] - hb * a[1]) / determinant, (a[0] * hb - b[0] * ha) / determinant]
  })
}

export function outlineFront(ring: readonly Point[], x: number): number {
  let front = Number.NEGATIVE_INFINITY
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    if (a && b && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0])) {
      const t = Math.abs(b[0] - a[0]) < 1e-8 ? 0 : (x - a[0]) / (b[0] - a[0])
      front = Math.max(front, a[1] + (b[1] - a[1]) * t)
    }
  }
  return front
}
