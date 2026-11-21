/** Fit weather-lap siding outside Frontier walls without filling an aperture. */
import type { Node } from '@gltf-transform/core'
import type { Building, Side, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { frontOf } from '../../src/experiments/out-west/ffa/sim/porches.ts'
import type { Structure } from './frontier-collision.ts'
import { type FrontierGeometry, frontierIO, type Rgb } from './frontier-geometry.ts'

type Point = [number, number, number]
interface Board {
  positions: Point[]
  indices: number[]
}
const frontage = new Set([
  'saloon',
  'hotel',
  'livery',
  'stage_line',
  'smithy',
  'assay',
  'general_store',
  'undertaker',
  'depot',
])
const spanAxis = {
  n: [-1, 0],
  s: [1, 0],
  e: [0, -1],
  w: [0, 1],
} as const
const course = 0.285
const boardsPerSpan = 3.4

export async function readClapboards(path: string): Promise<Board[]> {
  const art = await frontierIO.read(path)
  const variations = art
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .map((part) => {
      const vertex = part.getAttribute('POSITION')
      const indices = part.getIndices()?.getArray()
      if (!(vertex && indices)) {
        throw new Error('Incomplete authored siding board')
      }
      return {
        positions: Array.from(
          { length: vertex.getCount() },
          (_, i) => vertex.getElement(i, [0, 0, 0]) as Point,
        ),
        indices: Array.from(indices),
      }
    })
  if (variations.length !== 3) {
    throw new Error('Expected three siding board profiles')
  }
  return variations
}

function frontageSide(building: Building, wall: Structure, layout: TownLayout): Side | undefined {
  const front = frontOf(building, layout)
  if (
    frontage.has(building.id) &&
    (wall.id.startsWith(`${building.id}:${front}:`) || wall.id === `${building.id}:false-front`)
  ) {
    return front
  }
  return undefined
}

function fitCourse(
  geometry: FrontierGeometry,
  root: Node,
  board: Board,
  {
    tangent,
    center,
    span,
    bottom,
    height,
    role,
    tint,
  }: {
    tangent: readonly [number, number]
    center: readonly [number, number]
    span: number
    bottom: number
    height: number
    role: string
    tint: Rgb
  },
): void {
  const [tx, tz] = tangent
  const points: number[] = []
  const uv: number[] = []
  for (const [across, up, depth] of board.positions) {
    const x = across * span
    const y = up * height
    points.push(center[0] + tx * x - tz * depth, bottom + y, center[1] + tz * x + tx * depth)
    // The shared timber scan runs along V. Rotate the grain for horizontal siding.
    uv.push((bottom + y) * 1.8, (x + center[0] * tx + center[1] * tz) * 0.46)
  }
  geometry.surface(
    root,
    role,
    { id: 'siding-board', positions: points, indices: board.indices, uvs: uv },
    tint,
  )
}

export function dressSiding(
  geometry: FrontierGeometry,
  root: Node,
  {
    building,
    wall,
    layout,
    boards,
    role,
    color,
  }: {
    building: Building
    wall: Structure
    layout: TownLayout
    boards: Board[]
    role: string
    color: Rgb
  },
): void {
  const side = frontageSide(building, wall, layout)
  if (!side) {
    return
  }
  const tangent = spanAxis[side]
  const [tx, tz] = tangent
  const along = tx === 0 ? wall.d : wall.w
  const portions = Math.max(1, Math.ceil(along / boardsPerSpan))
  const [x, z] = [wall.x + wall.w / 2 - (tz * wall.w) / 2, wall.z + wall.d / 2 + (tx * wall.d) / 2]
  for (let row = Math.floor(wall.y0 / course); row * course < wall.y1; row++) {
    const bottom = Math.max(wall.y0, row * course)
    const top = Math.min(wall.y1, (row + 1) * course)
    const height = top - bottom
    if (height < 0.008) {
      continue
    }
    const span = along / portions
    for (let piece = 0; piece < portions; piece++) {
      const offset = (piece + 0.5) * span - along / 2
      const board = boards[(row + piece) % boards.length]
      if (!board) {
        throw new Error('Missing authored siding variation')
      }
      const tone = 1 - 0.1 * Math.sin((row + 3) * 17.1 + (piece + 4) * 22.9) ** 2
      fitCourse(geometry, root, board, {
        tangent,
        center: [x + tx * offset, z + tz * offset],
        span: Math.max(span * 0.8, span - 0.006),
        bottom,
        height,
        role,
        tint: [color[0] * tone, color[1] * tone, color[2] * tone],
      })
    }
  }
}
