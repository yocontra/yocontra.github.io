import type { Node } from '@gltf-transform/core'
import type { Building, Side } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import {
  frontOf,
  PORCH_DEPTH,
  PORCHED,
  sideStrip,
} from '../../src/experiments/out-west/ffa/sim/porches.ts'
import type { FrontierPlan } from './frontier-authoring.ts'
import type { FrontierGeometry, Rgb } from './frontier-geometry.ts'
import { LABELS, SHORT_LABELS, SIGN_ROWS } from './frontier-materials.ts'
/** Add detail outside an opening; no opaque quads cross its line of fire. */
export function surround(
  g: FrontierGeometry,
  root: Node,
  opening: { side: Side; x: number; z: number; width: number; y0: number; y1: number; tint?: Rgb },
) {
  const { side, x, z, width, y0, y1, tint = [0.82, 0.72, 0.53] } = opening
  const horizontal = side === 'n' || side === 's'
  const box = (along: number, y: number, span: number, height: number) =>
    g.box(
      root,
      'wood',
      {
        x: horizontal ? x + along : x - 0.08,
        z: horizontal ? z - 0.08 : z + along,
        w: horizontal ? span : 0.16,
        d: horizontal ? 0.16 : span,
        y0: y,
        top: y + height,
      },
      tint,
    )
  box(-0.12, y0 - 0.1, width + 0.24, 0.1)
  box(-0.12, y1, width + 0.24, 0.14)
  box(-0.12, y0, 0.12, y1 - y0)
  box(width, y0, 0.12, y1 - y0)
}

export function buildingDetails(
  g: FrontierGeometry,
  plan: FrontierPlan,
  building: Building,
  root: Node,
) {
  const { x, z, w, d, height } = building
  const paint = plan.style.buildingPaint[building.id] ?? plan.style.woodTint
  const trim: Rgb = [0.82, 0.72, 0.53]
  if (building.hollow) {
    // A real 3 cm floor, with matching native support, and a ceiling below the roof.
    g.box(root, 'floor', { x, z, w, d, y0: 0, top: 0.03 }, [0.83, 0.72, 0.55])
    g.box(root, 'wood', { x, z, w, d, y0: height - 0.14, top: height }, [0.6, 0.49, 0.35])
  }
  // The corner timbers, foundation and eaves define scale without extra materials.
  for (const dx of [0, w - 0.15]) {
    for (const dz of [0, d - 0.15]) {
      g.box(root, 'wood', { x: x + dx, z: z + dz, w: 0.15, d: 0.15, y0: 0, top: height }, trim)
    }
  }
  for (const side of ['n', 's', 'e', 'w'] as const) {
    const strip = sideStrip(building, side, 0.13)
    g.box(root, 'wood', { ...strip, y0: height - 0.21, top: height + 0.04 }, trim)
  }
  const front = frontOf(building, plan.layout)
  porchSupports(g, root, building, { front, paint })
  buildingSign(g, root, building, front)
  hangingSign(g, root, building, front)
  if (building.kind === 'church' || building.kind === 'tower') {
    const centerX = x + w / 2
    const centerZ = z + d / 2
    if (building.kind === 'tower') {
      g.box(
        root,
        'wood',
        { x: centerX - 0.1, z: centerZ - 0.1, w: 0.2, d: 0.2, y0: height, top: height + 2.1 },
        trim,
      )
      g.box(
        root,
        'wood',
        {
          x: centerX - 0.65,
          z: centerZ - 0.1,
          w: 1.3,
          d: 0.2,
          y0: height + 1.15,
          top: height + 1.35,
        },
        trim,
      )
    }
  }
  buildingDoors(g, root, building)
}

function buildingSign(g: FrontierGeometry, root: Node, building: Building, front: Side) {
  const { x, z, w, d, height } = building
  if (!Object.hasOwn(LABELS, building.id)) {
    return
  }
  {
    const index = Object.keys(LABELS).indexOf(building.id)
    const alongX = front === 'n' || front === 's'
    const span =
      (front === 'n' || front === 'e' ? -1 : 1) *
      Math.min((alongX ? w : d) - 1, Math.max(5, LABELS[building.id]?.length ?? 5) * 0.43)
    const cx = x + w / 2
    const cz = z + d / 2
    const at = { s: z + d + 0.14, n: z - 0.14, e: x + w + 0.14, w: x - 0.14 }[front]
    const bottom = Math.min(height - 1.15, 3.4)
    const points = alongX
      ? [
          [cx - span / 2, bottom, at],
          [cx + span / 2, bottom, at],
          [cx + span / 2, bottom + 0.85, at],
          [cx - span / 2, bottom + 0.85, at],
        ]
      : [
          [at, bottom, cz - span / 2],
          [at, bottom, cz + span / 2],
          [at, bottom + 0.85, cz + span / 2],
          [at, bottom + 0.85, cz - span / 2],
        ]
    const v0 = index / SIGN_ROWS.length
    const v1 = (index + 1) / SIGN_ROWS.length
    g.quad(root, 'sign', points, {
      uvs: [
        [0, v1],
        [1, v1],
        [1, v0],
        [0, v0],
      ],
    })
  }
}

function porchSupports(
  g: FrontierGeometry,
  root: Node,
  building: Building,
  options: { front: Side; paint: Rgb },
) {
  const { x, z, w, d } = building
  const { front, paint } = options
  if (PORCHED.has(building.kind)) {
    const strip = sideStrip(building, front, PORCH_DEPTH)
    const horizontal = front === 'n' || front === 's'
    const length = horizontal ? w : d
    for (let along = 0.25; along < length; along += 4.5) {
      const px = horizontal ? x + along : strip.x + (front === 'e' ? 1.7 : 0.3)
      const pz = horizontal ? strip.z + (front === 's' ? 1.7 : 0.3) : z + along
      g.box(
        root,
        'wood',
        { x: px - 0.08, z: pz - 0.08, w: 0.16, d: 0.16, y0: 0.06, top: 3.1 },
        paint,
      )
    }
  }
}

function buildingDoors(g: FrontierGeometry, root: Node, building: Building) {
  const { x, z, w, d } = building
  const trim: Rgb = [0.82, 0.72, 0.53]
  // Open upper balcony doorways share the same precise lintel/threshold geometry as physics.
  for (const door of building.doors) {
    const horizontal = door.side === 'n' || door.side === 's'
    surround(g, root, {
      side: door.side,
      tint: trim,
      x: horizontal ? x + door.at : { w: x - 0.02, e: x + w + 0.02, n: x, s: x }[door.side],
      z: horizontal ? { n: z - 0.02, s: z + d + 0.02, e: z, w: z }[door.side] : z + door.at,
      width: door.width,
      y0: door.y0 ?? 0,
      y1: door.y1 ?? 2.45,
    })
  }
}

export function signQuad(g: FrontierGeometry, root: Node, index: number, points: number[][]): void {
  const v0 = index / SIGN_ROWS.length
  const v1 = (index + 1) / SIGN_ROWS.length
  g.quad(root, 'sign', points, {
    uvs: [
      [0, v1],
      [1, v1],
      [1, v0],
      [0, v0],
    ],
  })
}
function hangingSign(g: FrontierGeometry, root: Node, b: Building, front: Side) {
  if (!(Object.hasOwn(SHORT_LABELS, b.id) && ['n', 's'].includes(front))) {
    return
  }
  const x = b.x + 0.75
  const z = front === 's' ? b.z + b.d + 0.22 : b.z - 1.72
  const index = Object.keys(LABELS).length + Object.keys(SHORT_LABELS).indexOf(b.id)
  signQuad(g, root, index, [
    [x - 0.041, 2.25, z],
    [x - 0.041, 2.25, z + 1.5],
    [x - 0.041, 2.95, z + 1.5],
    [x - 0.041, 2.95, z],
  ])
  signQuad(g, root, index, [
    [x + 0.041, 2.25, z + 1.5],
    [x + 0.041, 2.25, z],
    [x + 0.041, 2.95, z],
    [x + 0.041, 2.95, z + 1.5],
  ])
}
export function bankServiceSigns(g: FrontierGeometry, root: Node, layout: FrontierPlan['layout']) {
  for (const [index, zone] of layout.zones.filter((v) => v.kind === 'bank').entries()) {
    signQuad(g, root, SIGN_ROWS.length - 4 + index, [
      [zone.x + 0.8, 2.7, zone.z + 0.94],
      [zone.x - 0.8, 2.7, zone.z + 0.94],
      [zone.x - 0.8, 3.12, zone.z + 0.94],
      [zone.x + 0.8, 3.12, zone.z + 0.94],
    ])
  }
}
