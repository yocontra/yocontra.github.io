/** Closed, modest ironwork shared verbatim by the town renderer and native collision compiler. */
import type { Building, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import {
  frontOf,
  PORCH_ROOF,
  PORCH_ROOF_T,
  PORCHED,
} from '../../src/experiments/out-west/ffa/sim/porches.ts'
import type { CollisionMesh } from './frontier-collision.ts'

type Point = [number, number, number]
export interface FrontierMount extends CollisionMesh {
  owner: string
  family: 'sign' | 'bracket' | 'lantern' | 'bank'
}
export const MOUNT_IRON_TINT = [0.43, 0.41, 0.38] as const
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
function unit(p: Point): Point {
  const length = Math.hypot(...p)
  if (!(length > 0)) {
    throw new Error('Iron member has no direction')
  }
  return [p[0] / length, p[1] / length, p[2] / length]
}
function profile(width: number, depth: number): [number, number][] {
  const x = width / 2
  const y = depth / 2
  const bevel = Math.min(0.0015, width / 5, depth / 5)
  return [
    [x, -y + bevel],
    [x, y - bevel],
    [x - bevel, y],
    [-x + bevel, y],
    [-x, y - bevel],
    [-x, -y + bevel],
    [-x + bevel, -y],
    [x - bevel, -y],
  ]
}

/** Flat faces preserve a small forged profile; repeated seam positions remain watertight. */
function sweep(
  meta: Pick<FrontierMount, 'id' | 'owner' | 'family'>,
  path: Point[],
  section: [number, number][],
  { normal, closed = false }: { normal: Point; closed?: boolean },
): FrontierMount {
  const positions: number[] = []
  const indices: number[] = []
  const rings = path.map((p, i) => {
    const previous = path[(i - 1 + path.length) % path.length] ?? p
    const next = path[(i + 1) % path.length] ?? p
    const tangent = unit(
      sub(!closed && i === path.length - 1 ? p : next, !closed && i === 0 ? p : previous),
    )
    const v = unit(cross(tangent, normal))
    return section.map(
      ([x, y]): Point => [
        Math.fround(p[0] + normal[0] * x + v[0] * y),
        Math.fround(p[1] + normal[1] * x + v[1] * y),
        Math.fround(p[2] + normal[2] * x + v[2] * y),
      ],
    )
  })
  const face = (points: Point[]) => {
    const start = positions.length / 3
    for (const p of points) {
      positions.push(...p)
    }
    for (let i = 1; i < points.length - 1; i++) {
      indices.push(start, start + i, start + i + 1)
    }
  }
  for (let i = 0; i < rings.length - (closed ? 0 : 1); i++) {
    const a = rings[i]
    const b = rings[(i + 1) % rings.length]
    if (!(a && b)) {
      throw new Error('Missing iron profile ring')
    }
    for (let j = 0; j < section.length; j++) {
      const k = (j + 1) % section.length
      face([a[j], a[k], b[k], b[j]] as Point[])
    }
  }
  if (!closed) {
    face([...(rings[0] ?? [])].reverse())
    face(rings.at(-1) ?? [])
  }
  return { ...meta, positions, indices }
}

function makeMembers(owner: string, family: FrontierMount['family']) {
  const members: FrontierMount[] = []
  const add = (name: string, path: Point[], width: number, depth = width) => {
    members.push(
      sweep({ id: `mount:${owner}:${name}`, owner, family }, path, profile(width, depth), {
        normal: [1, 0, 0],
      }),
    )
  }
  const rivet = (name: string, [x, y, z]: Point) =>
    add(
      name,
      [
        [x, y, z],
        [x, y, z + 0.008],
      ],
      0.014,
    )
  return { members, add, rivet }
}

function hanger(owner: string, at: { name: string; x: number; z: number; upper: number }) {
  const { name, x, z, upper } = at
  const result = makeMembers(owner, 'sign')
  const lower = 2.945
  const radius = 0.004
  const center = (lower + upper) / 2
  const path: Point[] = Array.from({ length: 16 }, (_, i) => {
    const angle = (i * Math.PI) / 8
    return [
      x + Math.cos(angle) * 0.014,
      center + Math.sin(angle) * ((upper - lower) / 2 - radius),
      z,
    ]
  })
  const section: [number, number][] = Array.from({ length: 6 }, (_, i) => [
    Math.cos((i * Math.PI) / 3) * radius,
    Math.sin((i * Math.PI) / 3) * radius,
  ])
  result.members.push(
    sweep({ id: `mount:${owner}:${name}:eye`, owner, family: 'sign' }, path, section, {
      normal: [0, 0, 1],
      closed: true,
    }),
  )
  result.add(
    `${name}:board-shoe`,
    [
      [x, 2.947, z],
      [x, 2.957, z],
    ],
    0.05,
    0.05,
  )
  result.add(
    `${name}:upper-shoe`,
    [
      [x, upper - 0.008, z],
      [x, upper + 0.002, z],
    ],
    0.04,
    0.05,
  )
  return result.members
}

function wallBracket(owner: string, x: number, wall: number) {
  const result = makeMembers(owner, 'bracket')
  result.add(
    'wall-plate',
    [
      [x, 3.01, wall + 0.006],
      [x, 3.69, wall + 0.006],
    ],
    0.1,
    0.016,
  )
  result.add(
    'arm',
    [
      [x, 3.1, wall + 0.006],
      [x, 3.1, wall + 1.76],
    ],
    0.032,
    0.028,
  )
  result.add(
    'tie',
    [
      [x, 3.62, wall + 0.014],
      [x, 3.1, wall + 1.6],
    ],
    0.018,
  )
  result.add(
    'turned-tip',
    [
      [x, 3.1, wall + 1.75],
      [x, 3.17, wall + 1.75],
    ],
    0.022,
  )
  for (const [i, y] of [3.06, 3.34, 3.63].entries()) {
    result.rivet(`wall-rivet:${i}`, [x, y, wall + 0.013])
  }
  return result.members
}

function lampBracket(owner: string, x: number, wall: number) {
  const result = makeMembers(owner, 'lantern')
  result.add(
    'lamp-wall-plate',
    [
      [x, 2.92, wall + 0.005],
      [x, 3.2, wall + 0.005],
    ],
    0.085,
    0.016,
  )
  result.add(
    'lamp-arm',
    [
      [x, 3.08, wall + 0.008],
      [x, 3.08, wall + 0.24],
    ],
    0.014,
  )
  result.add(
    'lamp-brace',
    [
      [x, 2.98, wall + 0.013],
      [x, 3.08, wall + 0.19],
    ],
    0.01,
  )
  const path: Point[] = [[x, 3.08, wall + 0.24]]
  for (let step = 0; step <= 12; step++) {
    const theta = (step * Math.PI) / 12
    path.push([x, 2.862 - 0.015 * Math.sin(theta), wall + 0.225 + 0.015 * Math.cos(theta)])
  }
  const section: [number, number][] = Array.from({ length: 8 }, (_, i) => [
    Math.cos((i * Math.PI) / 4) * 0.004,
    Math.sin((i * Math.PI) / 4) * 0.004,
  ])
  result.members.push(
    sweep({ id: `mount:${owner}:lamp-hook`, owner, family: 'lantern' }, path, section, {
      normal: [1, 0, 0],
    }),
  )
  for (const [i, y] of [2.96, 3.16].entries()) {
    result.rivet(`lamp-rivet:${i}`, [x, y, wall + 0.012])
  }
  return result.members
}

function boardPosition(building: Building, layout: TownLayout) {
  const front = frontOf(building, layout)
  if (front !== 'n' && front !== 's') {
    return null
  }
  const x = building.x + 0.75
  const wall = front === 's' ? building.z + building.d : building.z
  const z = front === 's' ? wall + 0.22 : wall - 1.72
  const board = layout.cover.find(
    (c) =>
      c.kind === 'post' &&
      Math.abs(c.x - (x - 0.04)) < 1e-6 &&
      Math.abs(c.z - z) < 1e-6 &&
      c.w === 0.08 &&
      c.d === 1.5 &&
      c.top === 2.95,
  )
  return board ? { x, wall, z, front } : null
}

function bankFeet(building: Building, layout: TownLayout) {
  const result = makeMembers(building.id, 'bank')
  for (const [index, grille] of layout.cover.entries()) {
    if (
      grille.kind !== 'bars' ||
      grille.y0 !== 1.3 ||
      grille.top !== 2.6 ||
      grille.x < building.x ||
      grille.x + grille.w > building.x + building.w ||
      grille.z < building.z ||
      grille.z > building.z + building.d
    ) {
      continue
    }
    const counter = layout.cover.find(
      (c) =>
        c.kind === 'counter' &&
        c.x === grille.x &&
        c.w === grille.w &&
        c.z <= grille.z &&
        c.z + c.d >= grille.z + grille.d &&
        c.top === 1.1,
    )
    if (counter?.top !== 1.1) {
      throw new Error(`Bank grille ${index} has no counter support`)
    }
    for (const [end, dx] of [0.045, grille.w - 0.045].entries()) {
      const x = grille.x + dx
      const z = grille.z + grille.d / 2
      result.add(
        `grille:${index}:foot:${end}`,
        [
          [x, counter.top, z],
          [x, grille.y0 + 0.01, z],
        ],
        0.09,
      )
    }
  }
  return result.members
}

export function frontierMounts(layout: TownLayout): FrontierMount[] {
  const members: FrontierMount[] = []
  for (const building of layout.buildings) {
    const board = boardPosition(building, layout)
    if (board) {
      const { x, wall, z, front } = board
      const porch = PORCHED.has(building.kind)
      const upper = porch ? PORCH_ROOF - PORCH_ROOF_T / 2 + 0.005 : 3.095
      for (const [i, offset] of [0.25, 1.25].entries()) {
        members.push(...hanger(building.id, { name: `hanger:${i}`, x, z: z + offset, upper }))
      }
      if (!porch) {
        if (front !== 's') {
          throw new Error(`Unsupported wall-bracket facade ${building.id}`)
        }
        members.push(...wallBracket(building.id, x, wall))
      }
      if (building.id === 'livery') {
        members.push(...lampBracket(building.id, building.x + 0.545, wall))
      }
    }
    if (building.kind === 'bank') {
      members.push(...bankFeet(building, layout))
    }
  }
  return members
}

export interface FrontierMountGroup extends CollisionMesh {
  positions: number[]
  indices: number[]
  owner: string
  parts: {
    id: string
    family: FrontierMount['family']
    firstIndex: number
    indexCount: number
    firstVertex: number
    vertexCount: number
  }[]
}

/** Concatenate only; rendering and Ammo retain the same closed members and all real openings. */
export function groupFrontierMounts(members: readonly FrontierMount[]): FrontierMountGroup[] {
  const groups = new Map<string, FrontierMountGroup>()
  for (const member of members) {
    let group = groups.get(member.owner)
    if (!group) {
      group = {
        id: `mount:${member.owner}`,
        owner: member.owner,
        positions: [],
        indices: [],
        parts: [],
      }
      groups.set(member.owner, group)
    }
    const vertex = group.positions.length / 3
    group.parts.push({
      id: member.id,
      family: member.family,
      firstIndex: group.indices.length,
      indexCount: member.indices.length,
      firstVertex: vertex,
      vertexCount: member.positions.length / 3,
    })
    group.positions.push(...member.positions)
    group.indices.push(...member.indices.map((index) => index + vertex))
  }
  return [...groups.values()]
}
