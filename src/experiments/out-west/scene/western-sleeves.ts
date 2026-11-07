/** Set-in sleeves share a real armhole boundary with the torso, without an overlapping cap rim. */
import { type BufferGeometry, type Color, Quaternion, Vector3 } from 'three'
import { type Body, boneKey, type WeightFn } from './fit.ts'
import type { Cuff } from './garment-mesh.ts'
import { SLOT } from './roles.ts'
import { sleevePath } from './western-cap.ts'
import { shirtTorsoWeights, sleeveWeights } from './western-weights.ts'

export interface ShirtGrid {
  positions: number[]
  colors: number[]
  uv: number[]
  indices: number[]
  rows: number
  segs: number
  lo: number
  hi: number
  cuffs: Cuff[]
  bindings: Map<number, ReturnType<WeightFn>>
  sleeveUvs: Map<number, readonly [number, number]>
}
function sleeveRadius(
  body: Body,
  center: Vector3,
  axis: Vector3,
  fit: { radius: number; maxScale: number },
): number {
  const radii = body.samples
    .filter(
      (s) =>
        s.slot === SLOT.Sleeves ||
        (s.slot === SLOT.Skin &&
          ['UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR'].includes(s.bone)),
    )
    .map((s) => s.p.clone().sub(center))
    .filter((p) => Math.abs(p.dot(axis)) < 0.055)
    .map((p) => p.addScaledVector(axis, -p.dot(axis)).length())
    .filter((r) => r < 0.12)
    .sort((a, b) => a - b)
  return Math.max(
    fit.radius,
    Math.min(
      fit.radius * fit.maxScale,
      (radii[Math.floor(radii.length * 0.95)] ?? fit.radius) + 0.008,
    ),
  )
}

export function sewSleeve(grid: ShirtGrid, side: 'L' | 'R', body: Body, color: Color): void {
  const upper = body.bones.find((bone) => boneKey(bone.name) === `UpperArm${side}`)
  const at = (key: string) =>
    body.bones.find((bone) => boneKey(bone.name) === key)?.getWorldPosition(new Vector3())
  const shoulder = upper?.getWorldPosition(new Vector3())
  const elbow = at(`LowerArm${side}`)
  const wrist = at(`Wrist${side}`)
  if (!(upper && shoulder && elbow && wrist)) {
    return
  }
  let previous = armhole(grid, side, shoulder.y)
  const aperture = previous.map((vertex) => new Vector3().fromArray(grid.positions, vertex * 3))
  const midpoint = aperture
    .reduce((sum, point) => sum.add(point), new Vector3())
    .divideScalar(previous.length)
  const outward = new Vector3(side === 'L' ? 1 : -1, 0, 0)
  const forward = new Vector3(0, 0, 1)
  const tangent = outward.clone().cross(forward)
  const first = aperture[0]?.clone().sub(midpoint) ?? forward.clone()
  const phase = Math.atan2(first.dot(tangent), first.dot(forward))
  // Uniform contour sampling avoids the old projected-angle fan and its 17x edge mismatch.
  const angles = aperture.map((_point, column) => {
    grid.sleeveUvs.set(previous[column] ?? -1, [column / previous.length, 1])
    return phase + (column / previous.length) * Math.PI * 2
  })
  const rows = sleevePath(midpoint, outward, { shoulder, elbow, wrist })
  const skin = sleeveWeights(body, side)
  const torso = shirtTorsoWeights(body)
  const anchors = aperture.map((point) => torso(point))
  const previousDirection = outward.clone()
  const turn = new Quaternion()
  for (const [row, frame] of rows.entries()) {
    turn.setFromUnitVectors(previousDirection, frame.direction)
    forward.applyQuaternion(turn).normalize()
    tangent.crossVectors(frame.direction, forward).normalize()
    previousDirection.copy(frame.direction)
    const radius = sleeveRadius(body, frame.center, frame.direction, {
      radius: frame.radius,
      maxScale: 1.25,
    })
    const current: number[] = []
    const blend = frame.cap === undefined ? 1 : frame.cap * frame.cap * (3 - 2 * frame.cap)
    const armWeights = skin(frame.center)
    for (const [col, theta] of angles.entries()) {
      const point = frame.center
        .clone()
        .addScaledVector(forward, Math.cos(theta) * radius)
        .addScaledVector(tangent, Math.sin(theta) * radius)
      const anchor = aperture[col]
      if (frame.cap !== undefined && anchor) {
        point.lerp(anchor, 1 - blend)
      }
      const vertex = grid.positions.length / 3
      const weights =
        frame.cap === undefined
          ? armWeights
          : [
              ...(anchors[col] ?? []).map(
                ([bone, weight]) => [bone, weight * (1 - blend)] as const,
              ),
              [upper, blend] as const,
            ]
      current.push(vertex)
      grid.bindings.set(vertex, weights)
      grid.positions.push(point.x, point.y, point.z)
      grid.colors.push(color.r, color.g, color.b)
      grid.uv.push(col / angles.length, 1 - (row + 1) / rows.length)
    }
    joinRings(previous, current, grid.indices)
    previous = current
  }
  grid.cuffs.push({ side, vertices: previous })
}

/** The material split permits a sleeve UV chart while positions/normals/bindings stay sewn. */
export function sleeveUv(
  geometry: BufferGeometry,
  chart: ReadonlyMap<number, readonly [number, number]>,
): void {
  const originals = geometry.userData.sourceVertices as number[]
  const uv = geometry.getAttribute('uv')
  for (const [vertex, source] of originals.entries()) {
    const value = chart.get(source)
    if (value) {
      uv.setXY(vertex, value[0], value[1])
    }
  }
}

/** Open the actual torso side and retain its perimeter as the sleeve's sewn first ring. */
function armhole(grid: ShirtGrid, side: 'L' | 'R', shoulderY: number): number[] {
  const rowAt = (height: number) =>
    Math.round(((height - grid.lo) / (grid.hi - grid.lo)) * grid.rows)
  const top = Math.max(2, Math.min(grid.rows - 1, rowAt(shoulderY + 0.035)))
  const bottom = Math.max(1, Math.min(top - 2, rowAt(shoulderY - 0.105)))
  const center = (grid.segs * (side === 'L' ? 1 : 3)) / 4
  const left = center - 2
  const right = center + 2
  const vertexAt = (row: number, col: number) => row * (grid.segs + 1) + col
  const hole = new Set<number>()
  for (let row = bottom; row <= top; row++) {
    for (let col = left; col <= right; col++) {
      hole.add(vertexAt(row, col))
    }
  }
  const keep: number[] = []
  for (let triangle = 0; triangle < grid.indices.length; triangle += 3) {
    const vertices = grid.indices.slice(triangle, triangle + 3)
    if (!vertices.every((vertex) => hole.has(vertex))) {
      keep.push(...vertices)
    }
  }
  grid.indices.splice(0, grid.indices.length, ...keep)
  const boundary: number[] = []
  for (let col = left; col <= right; col++) {
    boundary.push(vertexAt(bottom, col))
  }
  for (let row = bottom + 1; row <= top; row++) {
    boundary.push(vertexAt(row, right))
  }
  for (let col = right - 1; col >= left; col--) {
    boundary.push(vertexAt(top, col))
  }
  for (let row = top - 1; row > bottom; row--) {
    boundary.push(vertexAt(row, left))
  }
  roundArmhole(grid, boundary, { top, bottom, left, right })
  return boundary
}

/** A rounded armhole avoids a rectangular corner folding into a pointed shoulder dart. */
function roundArmhole(
  grid: ShirtGrid,
  boundary: number[],
  edge: { top: number; bottom: number; left: number; right: number },
): void {
  const surface = { positions: grid.positions.slice(), columns: grid.segs + 1 }
  const centerRow = (edge.top + edge.bottom) / 2
  const centerCol = (edge.left + edge.right) / 2
  const radiusRow = (edge.top - edge.bottom) / 2
  const radiusCol = (edge.right - edge.left) / 2
  const point = new Vector3()
  for (const vertex of boundary) {
    const originalRow = Math.floor(vertex / (grid.segs + 1))
    const originalCol = vertex % (grid.segs + 1)
    const rowDelta = (originalRow - centerRow) / radiusRow
    const colDelta = (originalCol - centerCol) / radiusCol
    const length = Math.hypot(rowDelta, colDelta)
    const row = centerRow + (rowDelta / length) * radiusRow
    const col = centerCol + (colDelta / length) * radiusCol
    surfacePoint(surface, row, col, point)
    grid.positions[vertex * 3] = point.x
    grid.positions[vertex * 3 + 1] = point.y
    grid.positions[vertex * 3 + 2] = point.z
    grid.uv[vertex * 2] = col / grid.segs
    grid.uv[vertex * 2 + 1] = row / grid.rows
  }
}

function surfacePoint(
  surface: { positions: number[]; columns: number },
  row: number,
  col: number,
  out: Vector3,
): void {
  out.set(0, 0, 0)
  const r0 = Math.floor(row)
  const c0 = Math.floor(col)
  for (const dr of [0, 1]) {
    for (const dc of [0, 1]) {
      const weight = (dr === 0 ? 1 - (row % 1) : row % 1) * (dc === 0 ? 1 - (col % 1) : col % 1)
      const index = ((r0 + dr) * surface.columns + c0 + dc) * 3
      out.x += (surface.positions[index] ?? 0) * weight
      out.y += (surface.positions[index + 1] ?? 0) * weight
      out.z += (surface.positions[index + 2] ?? 0) * weight
    }
  }
}

function joinRings(previous: number[], current: number[], triangles: number[]): void {
  for (let col = 0; col < current.length; col++) {
    const next = (col + 1) % current.length
    const a = previous[col]
    const b = previous[next]
    const c = current[col]
    const d = current[next]
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      throw new Error('Incomplete fitted sleeve ring')
    }
    triangles.push(a, b, c, b, d, c)
  }
}
