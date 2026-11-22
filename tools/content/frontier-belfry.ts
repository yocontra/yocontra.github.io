import type { Node } from '@gltf-transform/core'
import type { Building } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import type { FrontierGeometry, Rgb } from './frontier-geometry.ts'

export function authorBell(g: FrontierGeometry, root: Node, building: Building) {
  const x = building.x + building.w / 2
  const z = building.z + building.d / 2
  const beam = building.height - 0.12
  g.box(
    root,
    'wood',
    { x: building.x + 0.45, z: z - 0.14, w: building.w - 0.9, d: 0.28, y0: beam - 0.24, top: beam },
    [0.37, 0.26, 0.16],
  )
  const profile = [
    [0.16, 0.29],
    [0.39, 0.4],
    [0.52, 0.56],
    [0.64, 0.92],
    [0.77, 1.08],
    [0.79, 1.17],
    [0.67, 1.19],
    [0.58, 0.97],
    [0.48, 0.63],
  ]
  const steps = 28
  const point = (radius: number, drop: number, i: number): [number, number, number] => {
    const angle = (i * Math.PI * 2) / steps
    return [x + radius * Math.cos(angle), beam - drop, z + radius * Math.sin(angle)]
  }
  for (let i = 1; i < profile.length; i++) {
    const [r0 = 0, d0 = 0] = profile[i - 1] ?? []
    const [r1 = 0, d1 = 0] = profile[i] ?? []
    const tint: Rgb = i === 5 || i === 6 ? [0.69, 0.45, 0.23] : [0.52, 0.35, 0.19]
    for (let j = 0; j < steps; j++) {
      g.quad(
        root,
        'iron',
        [point(r0, d0, j), point(r0, d0, j + 1), point(r1, d1, j + 1), point(r1, d1, j)],
        { tint },
      )
    }
  }
  g.box(
    root,
    'iron',
    { x: x - 0.065, z: z - 0.065, w: 0.13, d: 0.13, y0: beam - 1.34, top: beam - 0.5 },
    [0.31, 0.24, 0.17],
  )
}
