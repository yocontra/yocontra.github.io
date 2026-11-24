/** Ribbed barrel cactus in normalized height and radius, with rigid areole clusters. */
import assert from 'node:assert/strict'

type Point = [number, number, number]
type Triangle = [number, number, number]

const RIBS = 8
const SIDES = RIBS * 2
const RINGS = [
  [0.035, 0.42],
  [0.15, 0.79],
  [0.42, 1],
  [0.68, 0.94],
  [0.85, 0.7],
  [0.953, 0.39],
] as const
const STEM: Point = [0.185, 0.24, 0.064]
const CREST: Point = [0.273, 0.342, 0.094]
const AREOLE: Point = [0.46, 0.373, 0.142]
const SPINE: Point = [0.73, 0.655, 0.343]

type Surface = (
  angle: number,
  y: number,
  polar: readonly [radius: number, lateral: number],
  color: Point,
) => number

const sweep = (y: number) => 0.071 * Math.sin(y * Math.PI)
const growth = (angle: number, y: number) =>
  1 + 0.037 * Math.sin(angle * 3 + 0.2) + 0.02 * Math.cos(angle * 5 - y * 2)

function addAreoles(phase: number, surface: Surface, faces: Triangle[]) {
  for (let rib = 0; rib < RIBS; rib++) {
    const direction = phase + (rib * 2 * Math.PI) / RIBS
    for (const row of [1, 2, 3, 4] as const) {
      const [ringY, ringRadius] = RINGS[row]
      const angle = direction + sweep(ringY)
      const y = ringY + 0.018 * Math.sin(rib * 2.71 + row * 1.83)
      const r = 0.5 * ringRadius * growth(angle, ringY)
      const spread = row < 4 ? 0.018 : 0.014
      const a = surface(angle, y, [r + 0.004, -spread], AREOLE)
      const b = surface(angle, y - 1.1 * spread, [r + 0.004, 0], AREOLE)
      const c = surface(angle, y, [r + 0.004, spread], AREOLE)
      const d = surface(angle, y + 1.1 * spread, [r + 0.004, 0], AREOLE)
      const knot = surface(angle, y, [r + 0.015, 0], SPINE)
      faces.push([a, knot, b], [b, knot, c], [c, knot, d], [d, knot, a])
      for (const side of [-1, 1]) {
        const tip = surface(
          angle,
          y + spread * (side > 0 ? 1.45 : 0.75),
          [r + spread * 1.75, side * spread * 1.7],
          SPINE,
        )
        faces.push([side === 1 ? d : a, tip, knot])
      }
    }
  }
}

function barrelShape(phase: number) {
  const positions: Point[] = []
  const colors: Point[] = []
  const faces: Triangle[] = []
  const vertex = (x: number, y: number, z: number, color: Point) => {
    colors.push(color)
    return positions.push([x, y, z]) - 1
  }
  const surface: Surface = (angle, y, [radius, lateral], color) =>
    vertex(
      Math.cos(angle) * radius - Math.sin(angle) * lateral,
      y,
      Math.sin(angle) * radius + Math.cos(angle) * lateral,
      color,
    )

  for (const [row, [y, radius]] of RINGS.entries()) {
    for (let side = 0; side < SIDES; side++) {
      const angle = phase + (side * 2 * Math.PI) / SIDES + sweep(y)
      const crest = side % 2 === 0
      const depth = crest ? 1 : 0.73 + 0.12 * Math.max(0, y - 0.7)
      const shade = (row === 0 ? 0.86 : 0.96) + 0.1 * y + 0.045 * Math.cos(side * 1.83 + row * 0.41)
      const color = (crest ? CREST : STEM).map((channel) => channel * shade) as Point
      surface(angle, y, [0.5 * radius * growth(angle, y) * depth, 0], color)
    }
  }
  const ground = vertex(0, 0, 0, STEM)
  const crown = vertex(0.018, 1, -0.018, CREST)
  for (let side = 0; side < SIDES; side++) {
    const next = (side + 1) % SIDES
    faces.push([ground, side, next])
    for (let row = 0; row < RINGS.length - 1; row++) {
      const lower = row * SIDES
      const upper = lower + SIDES
      faces.push(
        [lower + side, upper + side, lower + next],
        [lower + next, upper + side, upper + next],
      )
    }
    const top = (RINGS.length - 1) * SIDES
    faces.push([top + side, crown, top + next])
  }

  const stemFaceCount = faces.length
  addAreoles(phase, surface, faces)
  return { positions, colors, faces, stemFaceCount }
}

/** Keep the old width, height and depth, and follow the tilt of its rooted ring. */
export function fitBarrel(reference: Point[], base: Point[], phase: number) {
  const template = barrelShape(phase)
  const bounds = (points: Point[]) =>
    [0, 1, 2].map(
      (axis) =>
        [
          Math.min(...points.map((p) => p[axis] ?? 0)),
          Math.max(...points.map((p) => p[axis] ?? 0)),
        ] as const,
    )
  const [[x0, x1], [y0, y1], [z0, z1]] = bounds(reference) as [
    PointBounds,
    PointBounds,
    PointBounds,
  ]
  const [[u0, u1], , [v0, v1]] = bounds(template.positions) as [
    PointBounds,
    PointBounds,
    PointBounds,
  ]
  const center = [0, 1, 2].map(
    (axis) => base.reduce((total, p) => total + (p[axis] ?? 0), 0) / base.length,
  ) as Point
  let xx = 0
  let zz = 0
  let xz = 0
  let xy = 0
  let zy = 0
  for (const [x, y, z] of base) {
    const [dx, dy, dz] = [x - center[0], y - center[1], z - center[2]]
    xx += dx * dx
    zz += dz * dz
    xz += dx * dz
    xy += dx * dy
    zy += dz * dy
  }
  const determinant = xx * zz - xz * xz
  const [slopeX, slopeZ] =
    Math.abs(determinant) < 1e-10
      ? [0, 0]
      : [(xy * zz - zy * xz) / determinant, (zy * xx - xy * xz) / determinant]
  const fitted = template.positions.map(([u, y, v]): Point => {
    const x = x0 + ((x1 - x0) * (u - u0)) / (u1 - u0)
    const z = z0 + ((z1 - z0) * (v - v0)) / (v1 - v0)
    const slope = slopeX * (x - center[0]) + slopeZ * (z - center[2])
    return [x, y * (y1 - y0) + slope * (1 - y) ** 4, z]
  })
  const low = Math.min(...fitted.map((p) => p[1]))
  const high = Math.max(...fitted.map((p) => p[1]))
  const positions = fitted.map(([x, y, z]): Point => [
    x,
    y0 + ((y1 - y0) * (y - low)) / (high - low),
    z,
  ])
  return {
    ...template,
    positions,
    normals: barrelNormals(positions, template.faces, template.stemFaceCount),
  }
}

type PointBounds = readonly [number, number]

function barrelNormals(positions: Point[], faces: Triangle[], stemFaces: number) {
  const normals = positions.map((): Point => [0, 0, 0])
  const unit = ([x, y, z]: Point): Point => {
    const length = Math.hypot(x, y, z)
    if (length < 1e-12) {
      throw new Error('Degenerate barrel cactus triangle or normal')
    }
    return [x / length, y / length, z / length]
  }
  for (const [index, face] of faces.entries()) {
    const a = positions[face[0]]
    const b = positions[face[1]]
    const c = positions[face[2]]
    assert(a && b && c, 'Missing referenced barrel vertex')
    const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const crossed: Point = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
    const [x, y, z] = index < stemFaces ? crossed : unit(crossed)
    for (const vertex of face) {
      const normal = normals[vertex]
      assert(normal, 'Missing barrel normal')
      normal[0] += x
      normal[1] += y
      normal[2] += z
    }
  }
  return normals.map(unit)
}
