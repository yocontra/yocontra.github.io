import type { Node } from '@gltf-transform/core'
import { doorTop } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import type { Building } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import type { FrontierGeometry, Rgb } from './frontier-geometry.ts'

type Profile = [x: number, y: number]
const blockTints: Rgb[] = [
  [0.87, 0.77, 0.61],
  [0.81, 0.71, 0.55],
  [0.94, 0.84, 0.68],
  [0.89, 0.78, 0.62],
]
const pale: Rgb = [0.95, 0.87, 0.71]
const weathered: Rgb = [0.76, 0.64, 0.48]

/** Stone courses follow the façade. Their backs sit inside the existing wall. */
function ashlar(g: FrontierGeometry, root: Node, building: Building) {
  const facing = building.front === 's' ? 1 : -1
  const wallZ = building.z + (facing > 0 ? building.d : 0)
  const block = (
    place: { x: number; y: number; w: number; h: number; relief: number },
    tint: Rgb,
    role = 'masonry',
  ) => {
    const { x, y, w, h, relief } = place
    g.box(
      root,
      role,
      {
        x,
        w,
        z: facing > 0 ? wallZ - 0.018 : wallZ - relief,
        d: relief + 0.018,
        y0: y,
        top: y + h,
      },
      tint,
    )
  }

  const carve = (outline: Profile[], start: number, relief: number, tint: Rgb) => {
    const n = outline.length
    const positions = [start, relief].flatMap((offset) =>
      outline.flatMap(([x, y]) => [x, y, wallZ + offset * facing]),
    )
    const indices: number[] = []
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      indices.push(i, next, next + n, i, next + n, i + n)
    }
    for (let i = 1; i < n - 1; i++) {
      indices.push(n, n + i, n + i + 1)
    }
    if (facing < 0) {
      indices.reverse()
    }
    g.surface(root, 'masonry', { id: 'cut stone', positions, indices }, tint)
  }
  return { block, carve }
}

function quoinCourses(stone: ReturnType<typeof ashlar>, building: Building) {
  for (let i = 0; i < Math.floor((building.height - 0.35) / 0.41); i++) {
    const width = i % 2 === 0 ? 0.61 : 0.43
    const nearEdge = building.x + 0.09
    const farEdge = building.x + building.w - width - 0.09
    for (const x of [nearEdge, farEdge]) {
      stone.block(
        { x, y: 0.14 + i * 0.41, w: width, h: 0.398, relief: 0.095 },
        blockTints[i % blockTints.length] ?? pale,
      )
    }
  }
}

/** An elliptical arch or stone wheel built from individual shaped voussoirs. */
function arch(
  stone: ReturnType<typeof ashlar>,
  center: Profile,
  shape: { width: number; rise: number; rim: number; sectors: number; turn: number; depth: number },
) {
  const { width, rise, rim, sectors, turn, depth } = shape
  for (let i = 0; i < sectors; i++) {
    const gap = 0.01
    const a = (turn * i) / sectors + gap
    const b = (turn * (i + 1)) / sectors - gap
    const mid = (a + b) / 2
    const lintel = turn === Math.PI && i === Math.floor(sectors / 2)
    const point = (t: number, edge: number): Profile => [
      center[0] + (width + edge) * Math.cos(t),
      center[1] + (rise + edge) * Math.sin(t),
    ]
    const outer = rim + (lintel ? 0.075 : 0)
    stone.carve(
      [point(a, 0), point(a, outer), point(mid, outer), point(b, outer), point(b, 0)],
      -0.015,
      depth + (lintel ? 0.06 : 0),
      lintel ? pale : (blockTints[i % blockTints.length] ?? pale),
    )
  }
}

function chapelRose(stone: ReturnType<typeof ashlar>, center: Profile) {
  const outer = 1.03
  const [x, y] = center
  arch(stone, center, {
    width: outer,
    rise: outer,
    rim: 0.25,
    sectors: 24,
    turn: Math.PI * 2,
    depth: 0.14,
  })
  const backing: Profile[] = Array.from({ length: 48 }, (_, i) => {
    const t = (i * Math.PI) / 24
    return [x + 1.045 * Math.cos(t), y + 1.045 * Math.sin(t)]
  })
  stone.carve(backing, -0.01, 0.027, [0.33, 0.24, 0.17])
  for (let i = 0; i < 8; i++) {
    const t = (i * Math.PI) / 4
    const at = (r: number, angle: number): Profile => [
      x + r * Math.cos(angle),
      y + r * Math.sin(angle),
    ]
    stone.carve(
      [at(0.13, t), at(0.52, t - 0.21), at(1.02, t), at(0.52, t + 0.21)],
      0.02,
      0.135,
      pale,
    )
  }
  stone.carve(
    backing.map(([u, v]) => [x + (u - x) * 0.15, y + (v - y) * 0.15]),
    0.02,
    0.17,
    weathered,
  )
}

export function civicFacade(g: FrontierGeometry, root: Node, building: Building) {
  if (!['bank', 'church'].includes(building.kind)) {
    return
  }
  const door = building.doors.find((opening) => opening.side === building.front)
  if (!door) {
    return
  }
  const stone = ashlar(g, root, building)
  quoinCourses(stone, building)
  const chapel = building.kind === 'church'
  const center = building.x + door.at + door.width / 2
  const spring = door.y1 ?? (door.y0 ?? 0) + doorTop(door.width)
  const reveal = door.width / 2 + 0.19
  const course = (spring - 0.1) / 7
  for (const x of [center - reveal - 0.28, center + reveal]) {
    for (let i = 0; i < 7; i++) {
      stone.block(
        { x, y: 0.1 + i * course, w: 0.28, h: course - 0.012, relief: 0.105 },
        blockTints[i % blockTints.length] ?? pale,
      )
    }
  }
  if (chapel) {
    arch(stone, [center, spring], {
      width: reveal,
      rise: 0.255,
      rim: 0.135,
      sectors: 13,
      turn: Math.PI,
      depth: 0.13,
    })
    chapelRose(stone, [center, 5.83])
    const crossX = center - 0.1
    stone.block({ x: crossX, y: 7.16, w: 0.2, h: 0.74, relief: 0.1 }, pale)
    stone.block({ x: crossX - 0.18, y: 7.57, w: 0.56, h: 0.16, relief: 0.11 }, pale)
    return
  }
  stone.block(
    {
      x: center - reveal - 0.28,
      y: spring + 0.018,
      w: (reveal + 0.28) * 2,
      h: 0.111,
      relief: 0.19,
    },
    pale,
  )
  for (const window of building.windows ?? []) {
    if (window.side !== building.front) {
      continue
    }
    const x = building.x + window.at - 0.19
    const w = window.width + 0.38
    stone.block({ x, w, y: window.sill - 0.19, h: 0.08, relief: 0.19 }, weathered)
    stone.block({ x, w, y: window.sill - 0.11, h: 0.082, relief: 0.23 }, pale)
  }
  const base = building.height - 0.11
  for (const [offset, height, relief, tint] of [
    [-0.13, 0.082, 0.08, weathered],
    [-0.048, 0.105, 0.2, pale],
    [0.057, 0.09, 0.26, weathered],
  ] as const) {
    stone.block({ x: building.x, y: base + offset, w: building.w, h: height, relief }, tint)
  }
}
