/** Fittings built to their cover volumes from proportioned joinery. */
import type { Node } from '@gltf-transform/core'
import { frame, tube } from './frontier-carpentry.ts'
import type { FrontierGeometry, Placement, Rgb } from './frontier-geometry.ts'

export const DARK_WOOD: Rgb = [0.42, 0.3, 0.19]
export const IRON: Rgb = [0.2, 0.2, 0.19]

/** Blacksmith's anvil on a sawn stump; the library anvil is authored at true height. */
export function anvil(g: FrontierGeometry, root: Node, c: Placement) {
  const f = frame(c)
  const anvilHeight = Math.min(0.42, (c.top - f.base) * 0.55)
  const stump = c.top - anvilHeight
  const radius = Math.min(f.width / 2, 0.3)
  tube(g, root, {
    role: 'wood',
    tint: [0.55, 0.42, 0.3],
    from: f.point(0, 0, 0),
    to: f.point(0, 0, stump - f.base),
    radius,
    segments: 12,
  })
  g.prefab(root, 'k_anvil', { ...c, y0: stump }, {})
}

/** Grave marker: a dressed stone tablet on a plinth, with a stepped crown. */
export function headstone(g: FrontierGeometry, root: Node, c: Placement) {
  const f = frame(c)
  const height = c.top - f.base
  const half = f.length / 2
  const depth = f.width / 2
  const stone: Rgb = [0.46, 0.44, 0.4]
  g.box(root, 'masonry', f.block([-half, half], [-depth, depth], [0, 0.18]), [0.52, 0.5, 0.46])
  g.box(
    root,
    'masonry',
    f.block([-half + 0.05, half - 0.05], [-0.11, 0.11], [0.18, height - 0.16]),
    stone,
  )
  g.box(
    root,
    'masonry',
    f.block([-half + 0.12, half - 0.12], [-0.11, 0.11], [height - 0.16, height - 0.06]),
    stone,
  )
  g.box(root, 'masonry', f.block([-0.1, 0.1], [-0.11, 0.11], [height - 0.06, height]), stone)
}

/** Sawn beams stacked on spacer sticks to the authored pile height. */
export function lumber(g: FrontierGeometry, root: Node, c: Placement) {
  const f = frame(c)
  const height = c.top - f.base
  const half = f.length / 2
  const layers = Math.max(1, Math.round(height / 0.2))
  const beam = height / layers - 0.04
  const across = Math.max(1, Math.round(f.width / 0.2))
  const pitch = f.width / across
  for (let layer = 0; layer < layers; layer++) {
    const y = layer * (beam + 0.04)
    for (const a of [-half + 0.3, 0, half - 0.35]) {
      g.box(
        root,
        'wood',
        f.block([a - 0.03, a + 0.03], [-f.width / 2, f.width / 2], [y, y + 0.04]),
        DARK_WOOD,
      )
    }
    for (let i = 0; i < across; i++) {
      const b = -f.width / 2 + i * pitch
      const trim = 0.08 * hash(layer, i)
      g.box(
        root,
        'floor',
        f.block(
          [-half + trim, half - trim * 0.5],
          [b + 0.01, b + pitch - 0.01],
          [y + 0.04, y + 0.04 + beam],
        ),
        [0.74, 0.6, 0.42],
      )
    }
  }
}

function hash(a: number, b: number) {
  const value = Math.sin(a * 91.7 + b * 47.3) * 15_731.743
  return value - Math.floor(value)
}
