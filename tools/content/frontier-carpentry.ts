/** Proportioned joinery for cover whose collision volume has no matching library prop. */
import type { Node } from '@gltf-transform/core'
import type { FrontierGeometry, Placement, Rgb } from './frontier-geometry.ts'

type Point = [number, number, number]
export type Span = readonly [number, number]

/** Along/across coordinates about a cover volume's centre, independent of its world orientation. */
export function frame(c: { x: number; z: number; w: number; d: number; y0?: number }) {
  const alongX = c.w >= c.d
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const base = c.y0 ?? 0
  return {
    length: Math.max(c.w, c.d),
    width: Math.min(c.w, c.d),
    base,
    /** Axis-aligned block spanning `along` and `across` the volume, heights above its base. */
    block(along: Span, across: Span, height: Span): Placement {
      const [a0, a1] = along
      const [b0, b1] = across
      const y = { y0: base + height[0], top: base + height[1] }
      return alongX
        ? { x: cx + a0, z: cz + b0, w: a1 - a0, d: b1 - b0, ...y }
        : { x: cx + b0, z: cz + a0, w: b1 - b0, d: a1 - a0, ...y }
    },
    point(a: number, b: number, y: number): Point {
      return alongX ? [cx + a, base + y, cz + b] : [cx + b, base + y, cz + a]
    },
    /** World direction of the across axis, which wheel axles follow. */
    acrossAxis: (alongX ? [0, 0, 1] : [1, 0, 0]) as Point,
  }
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Point): Point => {
  const length = Math.hypot(...a) || 1
  return [a[0] / length, a[1] / length, a[2] / length]
}

export interface Member {
  role: string
  tint: Rgb
  from: Point
  to: Point
  radius: number
  segments?: number
  /** Close the ends; members buried in a hub or rim leave them open. */
  caps?: boolean
}

/** Round member from `from` to `to`: spokes, axles, bows, stovepipes, stumps. */
export function tube(g: FrontierGeometry, root: Node, member: Member) {
  const { from, to, radius, segments = 8, caps = true } = member
  const axis = normalize(sub(to, from))
  const helper: Point = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u = normalize(cross(helper, axis))
  const v = cross(axis, u)
  const ring = (center: Point, angle: number): Point => [
    center[0] + radius * (Math.cos(angle) * u[0] + Math.sin(angle) * v[0]),
    center[1] + radius * (Math.cos(angle) * u[1] + Math.sin(angle) * v[1]),
    center[2] + radius * (Math.cos(angle) * u[2] + Math.sin(angle) * v[2]),
  ]
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    positions.push(...ring(from, angle), ...ring(to, angle))
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2
    indices.push(a, a + 2, a + 3, a, a + 3, a + 1)
  }
  const ends: [Point, boolean][] = caps
    ? [
        [from, true],
        [to, false],
      ]
    : []
  for (const [center, flip] of ends) {
    const start = positions.length / 3
    positions.push(...center)
    for (let i = 0; i <= segments; i++) {
      positions.push(...ring(center, (i / segments) * Math.PI * 2))
    }
    for (let i = 1; i <= segments; i++) {
      indices.push(
        ...(flip ? [start, start + i + 1, start + i] : [start, start + i, start + i + 1]),
      )
    }
  }
  g.surface(root, member.role, { id: 'joinery', positions, indices }, member.tint)
}

interface Hoop {
  role: string
  tint: Rgb
  outer: number
  inner: number
  halfWidth: number
}

/** Iron-tyred, spoked wagon wheel standing on the ground at `center` (hub height = radius). */
export function wheel(
  g: FrontierGeometry,
  root: Node,
  wheelAt: { center: Point; axis: Point; radius: number; spokes?: number },
) {
  const { center, axis, radius, spokes = 12 } = wheelAt
  const u = normalize(cross([0, 1, 0], axis))
  const at = (r: number, angle: number, offset = 0): Point => [
    center[0] + r * (Math.cos(angle) * u[0]) + offset * axis[0],
    center[1] + r * Math.sin(angle),
    center[2] + r * (Math.cos(angle) * u[2]) + offset * axis[2],
  ]
  /** Rectangular-section hoop swept once around the hub: iron tyre or wooden felloe. */
  const hoop = ({ role, tint, outer, inner, halfWidth }: Hoop) => {
    const positions: number[] = []
    const indices: number[] = []
    const section: Span[] = [
      [outer, -halfWidth],
      [outer, halfWidth],
      [inner, halfWidth],
      [inner, -halfWidth],
      [outer, -halfWidth],
    ]
    const segments = 24
    for (let face = 0; face < 4; face++) {
      const start = positions.length / 3
      const edges = section.slice(face, face + 2)
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2
        for (const [r, offset] of edges) {
          positions.push(...at(r, angle, offset))
        }
      }
      for (let i = 0; i < segments; i++) {
        const a = start + i * 2
        indices.push(a, a + 3, a + 1, a, a + 2, a + 3)
      }
    }
    g.surface(root, role, { id: 'hoop', positions, indices }, tint)
  }
  hoop({
    role: 'iron',
    tint: [0.2, 0.19, 0.18],
    outer: radius,
    inner: radius - 0.025,
    halfWidth: 0.04,
  })
  hoop({
    role: 'wood',
    tint: [0.45, 0.33, 0.21],
    outer: radius - 0.025,
    inner: radius - 0.1,
    halfWidth: 0.035,
  })
  for (let i = 0; i < spokes; i++) {
    const angle = (i / spokes) * Math.PI * 2
    tube(g, root, {
      role: 'wood',
      tint: [0.5, 0.38, 0.24],
      from: at(0.08, angle),
      to: at(radius - 0.09, angle),
      radius: 0.018,
      segments: 5,
      caps: false,
    })
  }
  tube(g, root, {
    role: 'iron',
    tint: [0.24, 0.22, 0.2],
    from: at(0, 0, -0.1),
    to: at(0, 0, 0.1),
    radius: 0.085,
    segments: 10,
  })
}

export interface WagonGear {
  bedCenter: number
  bedLength: number
  bedWidth: number
  bedTop: number
  sideRise: number
  wheelRadius: number
  wheelInset: number
}

function sideboards(g: FrontierGeometry, root: Node, f: ReturnType<typeof frame>, gear: WagonGear) {
  const { bedCenter, bedLength, bedWidth, bedTop, sideRise } = gear
  const a0 = bedCenter - bedLength / 2
  const a1 = bedCenter + bedLength / 2
  const half = bedWidth / 2
  const top = bedTop + sideRise
  const plank: Rgb = [0.6, 0.47, 0.32]
  for (const b of [-half, half - 0.06]) {
    g.box(root, 'wood', f.block([a0, a1], [b, b + 0.06], [bedTop, top]), plank)
    g.box(
      root,
      'wood',
      f.block([a0, a1], [b - 0.01, b + 0.07], [top - 0.05, top]),
      [0.42, 0.31, 0.2],
    )
  }
  for (const a of [a0, a1 - 0.06]) {
    g.box(root, 'wood', f.block([a, a + 0.06], [-half, half], [bedTop, top]), plank)
  }
  for (let a = a0 + 0.6; a < a1 - 0.3; a += 0.9) {
    for (const b of [-half - 0.03, half]) {
      g.box(
        root,
        'iron',
        f.block([a, a + 0.05], [b, b + 0.03], [bedTop - 0.05, top]),
        [0.22, 0.2, 0.19],
      )
    }
  }
}

/** Running gear shared by farm, covered and freight wagons and the stagecoach. */
export function wagonGear(
  g: FrontierGeometry,
  root: Node,
  c: { x: number; z: number; w: number; d: number; y0?: number },
  gear: WagonGear,
) {
  const f = frame(c)
  const { bedCenter, bedLength, bedWidth, bedTop, sideRise, wheelRadius, wheelInset } = gear
  const a0 = bedCenter - bedLength / 2
  const a1 = bedCenter + bedLength / 2
  const half = bedWidth / 2
  g.box(root, 'floor', f.block([a0, a1], [-half, half], [bedTop - 0.07, bedTop]), [0.6, 0.47, 0.32])
  for (const y of [bedTop - 0.2, bedTop - 0.12]) {
    for (const b of [-half + 0.12, half - 0.12]) {
      g.box(
        root,
        'wood',
        f.block([a0 + 0.1, a1 - 0.1], [b - 0.05, b + 0.05], [y, y + 0.08]),
        [0.36, 0.27, 0.19],
      )
    }
  }
  if (sideRise > 0) {
    sideboards(g, root, f, gear)
  }
  const wheelB = f.width / 2 - wheelInset
  const iron: Rgb = [0.22, 0.2, 0.19]
  for (const a of [a0 + wheelRadius + 0.1, a1 - wheelRadius - 0.1]) {
    tube(g, root, {
      role: 'iron',
      tint: iron,
      from: f.point(a, -wheelB, wheelRadius),
      to: f.point(a, wheelB, wheelRadius),
      radius: 0.045,
    })
    g.box(
      root,
      'wood',
      f.block(
        [a - 0.07, a + 0.07],
        [-half + 0.05, half - 0.05],
        [wheelRadius + 0.04, bedTop - 0.2],
      ),
      [0.34, 0.25, 0.17],
    )
    for (const b of [-wheelB, wheelB]) {
      wheel(g, root, {
        center: f.point(a, b, wheelRadius),
        axis: f.acrossAxis,
        radius: wheelRadius,
      })
    }
  }
  const front = -f.length / 2
  tube(g, root, {
    role: 'wood',
    tint: [0.4, 0.3, 0.2],
    from: f.point(a0, 0, wheelRadius),
    to: f.point(front + 0.12, 0, 0.42),
    radius: 0.045,
  })
  g.box(
    root,
    'wood',
    f.block([front, front + 0.2], [-0.25, 0.25], [0.27, 0.35]),
    [0.38, 0.28, 0.18],
  )
}
