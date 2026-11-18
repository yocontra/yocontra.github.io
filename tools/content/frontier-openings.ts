import type { Node } from '@gltf-transform/core'
import { doorTop } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import type { Building, Side } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import type { FrontierGeometry, Rgb } from './frontier-geometry.ts'

/** Frame the opening from the outside face. No wood enters the clear opening. */
export function surround(
  g: FrontierGeometry,
  root: Node,
  building: Building,
  opening: {
    side: Side
    at: number
    width: number
    y0: number
    y1: number
    door?: boolean
  },
) {
  const { side, at, width, y0, y1, door = false } = opening
  const horizontal = side === 'n' || side === 's'
  const face = {
    n: building.z,
    s: building.z + building.d,
    w: building.x,
    e: building.x + building.w,
  }[side]
  const outward = side === 'n' || side === 'w' ? -1 : 1
  const start = (horizontal ? building.x : building.z) + at
  const reveal = 0.005
  const jamb = door ? 0.13 : 0.1
  const box = (
    [along, span]: [number, number],
    [bottom, top]: [number, number],
    projection: number,
    tint: Rgb,
  ) => {
    const edge = Math.min(face + outward * projection, face - outward * reveal)
    const depth = projection + reveal
    g.box(
      root,
      'wood',
      {
        x: horizontal ? start + along : edge,
        z: horizontal ? edge : start + along,
        w: horizontal ? span : depth,
        d: horizontal ? depth : span,
        y0: bottom,
        top,
      },
      tint,
    )
  }

  const casing: Rgb = door ? [0.82, 0.72, 0.53] : [0.76, 0.65, 0.47]
  const sill: Rgb = [0.62, 0.51, 0.36]
  const cap = jamb + 0.045
  box([-cap, width + cap * 2], [y0 - (door ? 0.04 : 0.105), y0], door ? 0.045 : 0.14, sill)
  box([-cap, width + cap * 2], [y1, y1 + (door ? 0.17 : 0.14)], 0.11, casing)
  box([-jamb, jamb], [y0, y1], 0.055, casing)
  box([width, jamb], [y0, y1], 0.055, casing)
}

export function buildingDoors(g: FrontierGeometry, root: Node, building: Building) {
  // Leave the full authored passage clear, including the upper balcony thresholds.
  for (const door of building.doors) {
    const bottom = door.y0 ?? 0
    surround(g, root, building, {
      side: door.side,
      at: door.at,
      width: door.width,
      y0: bottom,
      y1: door.y1 ?? bottom + doorTop(door.width),
      door: true,
    })
  }
}
