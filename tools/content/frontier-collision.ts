/** Offline native collider authoring; renderer and Ammo consume the same structural spans. */
import { createHash } from 'node:crypto'
import { buildingSideRect } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import {
  CANOPY_SEGMENTS,
  CANOPY_SPANS,
  canopyPoint,
  shapedCover,
  WAGON_BED,
} from '../../src/experiments/out-west/ffa/sim/cover-shape.ts'
import {
  type Building,
  buildGrid,
  buildingSideBoxes,
  type Cover,
  type Rect,
  type Surface,
  type TownLayout,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { roofHeightAt } from '../../src/experiments/out-west/ffa/sim/roofshape.ts'
import type { CollisionData } from '../../src/experiments/out-west/runtime/protocol.ts'

export type CollisionBox = CollisionData['boxes'][number] & { id: string }
export type CollisionMesh = CollisionData['meshes'][number] & { id: string }
export type Structure = Rect & { y0: number; y1: number; id: string }

/** Visible posts and rails are native collision too; bullets pass through the actual gaps. */
export function fenceSpans(cover: Cover): Structure[] {
  const horizontal = cover.w >= cover.d
  const length = horizontal ? cover.w : cover.d
  const top = cover.top ?? 1.1
  const bottom = cover.y0 ?? 0
  const posts = Math.max(1, Math.ceil(length / (cover.kind === 'bars' ? 0.28 : 1.3)))
  const spans: Structure[] = []
  for (let i = 0; i <= posts; i++) {
    spans.push({
      id: `post:${i}`,
      x: cover.x + (horizontal ? ((length - 0.09) * i) / posts : (cover.w - 0.09) / 2),
      z: cover.z + (horizontal ? (cover.d - 0.09) / 2 : ((length - 0.09) * i) / posts),
      w: 0.09,
      d: 0.09,
      y0: bottom,
      y1: top,
    })
  }
  for (const h of [0.38, 0.82]) {
    spans.push({
      id: `rail:${h}`,
      x: cover.x + (horizontal ? 0 : (cover.w - 0.09) / 2),
      z: cover.z + (horizontal ? (cover.d - 0.09) / 2 : 0),
      w: horizontal ? cover.w : 0.09,
      d: horizontal ? 0.09 : cover.d,
      y0: bottom + h * (top - bottom),
      y1: bottom + h * (top - bottom) + 0.09,
    })
  }
  return spans
}

/** Open canvas ends stay open in native physics; no heightfield invents an invisible curtain. */
export function wagonCanopy(cover: Cover): CollisionMesh & { uvs: number[] } {
  const positions: number[] = []
  const indices: number[] = []
  const uvs: number[] = []
  const alongX = cover.w >= cover.d
  for (let row = 0; row <= CANOPY_SPANS; row++) {
    for (let segment = 0; segment <= CANOPY_SEGMENTS; segment++) {
      const u = row / CANOPY_SPANS
      const t = segment / CANOPY_SEGMENTS
      const p = canopyPoint(cover, (cover.y0 ?? 0) + WAGON_BED + 0.12, cover.top ?? 3, { u, t })
      positions.push(
        cover.x + cover.w / 2 + (alongX ? p.along : p.across),
        p.y,
        cover.z + cover.d / 2 + (alongX ? p.across : p.along),
      )
      uvs.push(u * Math.max(cover.w, cover.d), t * 3)
    }
  }
  for (let row = 0; row < CANOPY_SPANS; row++) {
    for (let segment = 0; segment < CANOPY_SEGMENTS; segment++) {
      const a = row * (CANOPY_SEGMENTS + 1) + segment
      const b = a + CANOPY_SEGMENTS + 1
      indices.push(a, b, b + 1, a, b + 1, a + 1)
    }
  }
  return { id: 'canvas', positions, indices, uvs }
}

export function structuralWalls(layout: TownLayout): Structure[] {
  return layout.buildings.flatMap((building) => {
    if (building.kind === 'water_tower') {
      return [
        ...[0, building.w - 0.45].flatMap((dx) =>
          [0, building.d - 0.45].map((dz) => ({
            x: building.x + dx,
            z: building.z + dz,
            w: 0.45,
            d: 0.45,
            id: `${building.id}:support:${dx}:${dz}`,
            y0: 0,
            y1: building.height - 3,
          })),
        ),
        { ...building, id: `${building.id}:tank`, y0: building.height - 3, y1: building.height },
      ]
    }
    if (!building.hollow) {
      return [{ ...building, id: `building:${building.id}`, y0: 0, y1: building.height }]
    }
    return [
      ...(['n', 's', 'e', 'w'] as const).flatMap((side) =>
        buildingSideBoxes(building, side).map((wall, index) => ({
          ...wall,
          id: `${building.id}:${side}:${index}`,
        })),
      ),
      ...(building.walls ?? []).map((wall, index) => ({
        ...wall,
        id: `${building.id}:partition:${index}`,
        y0: wall.y0 ?? 0,
        y1: wall.y1 ?? building.height,
      })),
      ...(building.roof?.front
        ? [
            {
              ...buildingSideRect(
                building,
                building.roof.front,
                0,
                ['n', 's'].includes(building.roof.front) ? building.w : building.d,
              ),
              id: `${building.id}:false-front`,
              y0: building.height,
              y1: building.height + 1.5,
            },
          ]
        : []),
    ]
  })
}

function box(id: string, area: Rect, bottom: number, top: number): CollisionBox {
  return {
    id,
    center: [area.x + area.w / 2, (bottom + top) / 2, area.z + area.d / 2],
    halfExtents: [area.w / 2, (top - bottom) / 2, area.d / 2],
  }
}

/** Exact planar strips at every gable ridge/eave, rather than a costly sampled roof grid. */
export function roofMesh(building: Building): CollisionMesh | undefined {
  const roof = building.roof
  if (!roof) {
    return undefined
  }
  const alongX = roof.axis === 'x'
  const from = alongX ? building.z : building.x
  const span = (alongX ? building.d : building.w) / roof.bays
  const cuts = [from - roof.overhang]
  for (let bay = 0; bay < roof.bays; bay++) {
    cuts.push(from + bay * span, from + (bay + 0.5) * span)
  }
  cuts.push(from + roof.bays * span, from + roof.bays * span + roof.overhang)
  const positions: number[] = []
  const indices: number[] = []
  const low = (alongX ? building.x : building.z) - roof.overhang
  const high = (alongX ? building.x + building.w : building.z + building.d) + roof.overhang
  for (const cross of cuts) {
    for (const along of [low, high]) {
      const x = alongX ? along : cross
      const z = alongX ? cross : along
      positions.push(x, roofHeightAt(building, x, z), z)
    }
  }
  for (let row = 0; row < cuts.length - 1; row++) {
    const index = row * 2
    indices.push(
      ...(alongX
        ? [index, index + 2, index + 1, index + 1, index + 2, index + 3]
        : [index, index + 1, index + 2, index + 1, index + 3, index + 2]),
    )
  }
  return closeRoofEnds(
    thickenRoof({ id: `roof:${building.id}`, positions, indices }, cuts.length),
    building,
  )
}

function sampledMesh(
  id: string,
  area: Rect,
  height: (x: number, z: number) => number,
): CollisionMesh {
  const columns = Math.max(1, Math.ceil(area.w / 0.25))
  const rows = Math.max(1, Math.ceil(area.d / 0.25))
  const positions: number[] = []
  const indices: number[] = []
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const x = area.x + (area.w * column) / columns
      const z = area.z + (area.d * row) / rows
      positions.push(x, height(x, z), z)
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * (columns + 1) + column
      indices.push(
        index,
        index + columns + 1,
        index + 1,
        index + 1,
        index + columns + 1,
        index + columns + 2,
      )
    }
  }
  return { id, positions, indices }
}

function stairMesh(surface: Surface, index: number): CollisionMesh {
  const height = surface.heightAt
  if (!height) {
    throw new Error('Authored stair has no height function')
  }
  const positions = [
    surface.x,
    height(surface.x, surface.z),
    surface.z,
    surface.x + surface.w,
    height(surface.x + surface.w, surface.z),
    surface.z,
    surface.x,
    height(surface.x, surface.z + surface.d),
    surface.z + surface.d,
    surface.x + surface.w,
    height(surface.x + surface.w, surface.z + surface.d),
    surface.z + surface.d,
  ]
  return { id: `stair:${index}`, positions, indices: [0, 2, 1, 1, 2, 3] }
}

export function compileFrontierCollision(
  layout: TownLayout,
): CollisionData & { boxes: CollisionBox[]; meshes: CollisionMesh[] } {
  const size = layout.size
  const boxes = [
    box('ground', { x: 0, z: 0, w: size, d: size }, -1, 0),
    box('boundary:n', { x: 0, z: 0, w: size, d: 0.5 }, 0, 2.7),
    box('boundary:s', { x: 0, z: size - 0.5, w: size, d: 0.5 }, 0, 4),
    box('boundary:w', { x: 0, z: 0, w: 0.5, d: size }, 0, 12),
    box('boundary:e', { x: size - 0.5, z: 0, w: 0.5, d: size }, 0, 12),
    ...structuralWalls(layout).map((wall) => box(wall.id, wall, wall.y0, wall.y1)),
  ]
  const grid = buildGrid(layout)
  for (let x = 0; x < size; x += 4) {
    boxes.push(box(`boundary:n:post:${x}`, { x, z: 0, w: 0.2, d: 0.7 }, 0, 2.9))
  }
  for (const building of layout.buildings.filter((value) => value.hollow)) {
    boxes.push(box(`floor:${building.id}`, building, 0, 0.03))
    boxes.push(box(`ceiling:${building.id}`, building, building.height - 0.14, building.height))
  }
  const meshes = [
    ...grid.stairs.map(stairMesh),
    ...layout.buildings.flatMap((building) => roofMesh(building) ?? []),
  ]
  for (const [index, surface] of [
    ...grid.decks,
    ...grid.overheads.filter((value) => value.kind === 'overhead'),
  ].entries()) {
    boxes.push(box(`deck:${index}`, surface, surface.bottom, surface.top))
  }
  for (const [index, cover] of layout.cover.entries()) {
    if (cover.kind === 'fence' || cover.kind === 'bars') {
      for (const span of fenceSpans(cover)) {
        boxes.push(box(`cover:${index}:${span.id}`, span, span.y0, span.y1))
      }
      continue
    }
    const shape = shapedCover(cover)
    if (shape) {
      if (cover.kind === 'covered_wagon') {
        const { positions, indices } = wagonCanopy(cover)
        meshes.push({ id: `cover:${index}`, positions, indices })
      } else {
        meshes.push(sampledMesh(`cover:${index}`, cover, shape.heightAt))
      }
      if (cover.kind === 'covered_wagon') {
        boxes.push(box(`cover:${index}:bed`, cover, 0, 0.9))
      }
    } else {
      boxes.push(box(`cover:${index}`, cover, cover.y0 ?? 0, cover.top ?? 1))
    }
  }
  const version = createHash('sha256').update(JSON.stringify({ boxes, meshes })).digest('hex')
  return { version, boxes, meshes }
}

function thickenRoof(mesh: CollisionMesh, rows: number): CollisionMesh {
  const positions = [...mesh.positions]
  const indices = [...mesh.indices]
  const count = positions.length / 3
  const topIndices = [...indices]
  for (let vertex = 0; vertex < count; vertex++) {
    positions.push(
      positions[vertex * 3] ?? 0,
      (positions[vertex * 3 + 1] ?? 0) - 0.12,
      positions[vertex * 3 + 2] ?? 0,
    )
  }
  for (let triangle = 0; triangle < topIndices.length; triangle += 3) {
    indices.push(
      (topIndices[triangle] ?? 0) + count,
      (topIndices[triangle + 2] ?? 0) + count,
      (topIndices[triangle + 1] ?? 0) + count,
    )
  }
  const perimeter = [
    ...Array.from({ length: rows }, (_, row) => row * 2),
    ...Array.from({ length: rows }, (_, row) => (rows - 1 - row) * 2 + 1),
  ]
  for (let edge = 0; edge < perimeter.length; edge++) {
    const a = perimeter[edge] ?? 0
    const b = perimeter[(edge + 1) % perimeter.length] ?? 0
    indices.push(a, b, b + count, a, b + count, a + count)
  }

  return { ...mesh, positions, indices }
}

function closeRoofEnds(mesh: CollisionMesh, b: Building): CollisionMesh {
  const roof = b.roof
  if (!roof) {
    return mesh
  }
  const alongX = roof.axis === 'x'
  const cross = alongX ? b.z : b.x
  const span = (alongX ? b.d : b.w) / roof.bays
  const cuts = Array.from({ length: roof.bays * 2 + 1 }, (_, index) => cross + (index * span) / 2)
  const low = alongX ? b.x : b.z
  const high = low + (alongX ? b.w : b.d)
  const positions = [...mesh.positions]
  const indices = [...mesh.indices]
  for (const [end, along] of [low, high].entries()) {
    for (let index = 0; index < cuts.length - 1; index++) {
      const a = cuts[index] ?? 0
      const c = cuts[index + 1] ?? 0
      const point = (across: number, y: number) =>
        alongX ? [along, y, across] : [across, y, along]
      const height = (across: number) =>
        roofHeightAt(b, alongX ? along : across, alongX ? across : along)
      const start = positions.length / 3
      positions.push(
        ...point(a, b.height),
        ...point(c, b.height),
        ...point(c, height(c)),
        ...point(a, height(a)),
      )
      const reverse = alongX ? end === 1 : end === 0
      indices.push(
        ...(reverse
          ? [start, start + 2, start + 1, start, start + 3, start + 2]
          : [start, start + 1, start + 2, start, start + 2, start + 3]),
      )
    }
  }
  return { ...mesh, positions, indices }
}
