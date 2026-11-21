/** Furniture, fittings and rolling stock built to their cover volumes from proportioned joinery. */
import type { Node } from '@gltf-transform/core'
import { frame, tube, wheel } from './frontier-carpentry.ts'
import type { FrontierGeometry, Placement, Rgb } from './frontier-geometry.ts'

export const DARK_WOOD: Rgb = [0.42, 0.3, 0.19]
export const IRON: Rgb = [0.2, 0.2, 0.19]

/** Plank seat on two (or three) trestle legs with a stretcher. */
export function bench(g: FrontierGeometry, root: Node, c: Placement) {
  const f = frame(c)
  const height = c.top - f.base
  const half = f.length / 2
  const depth = f.width / 2 - 0.03
  g.box(
    root,
    'floor',
    f.block([-half, half], [-depth, depth], [height - 0.06, height]),
    [0.66, 0.52, 0.35],
  )
  const legs = f.length > 2.6 ? [-half + 0.2, 0, half - 0.26] : [-half + 0.2, half - 0.26]
  for (const a of legs) {
    g.box(
      root,
      'wood',
      f.block([a, a + 0.06], [-depth + 0.04, depth - 0.04], [0, height - 0.06]),
      DARK_WOOD,
    )
  }
  g.box(
    root,
    'wood',
    f.block([-half + 0.2, half - 0.2], [-0.04, 0.04], [height * 0.35, height * 0.35 + 0.08]),
    DARK_WOOD,
  )
}

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

/** Horse trough: plank walls around murky water, so the open top reads as a container. */
export function trough(g: FrontierGeometry, root: Node, c: Placement) {
  const f = frame(c)
  const height = c.top - f.base
  const half = f.length / 2
  const depth = f.width / 2
  const plank: Rgb = [0.5, 0.39, 0.27]
  g.box(root, 'wood', f.block([-half, half], [-depth, depth], [0, 0.12]), plank)
  for (const b of [-depth, depth - 0.07]) {
    g.box(root, 'wood', f.block([-half, half], [b, b + 0.07], [0.12, height]), plank)
  }
  for (const a of [-half, half - 0.07]) {
    g.box(
      root,
      'wood',
      f.block([a, a + 0.07], [-depth + 0.07, depth - 0.07], [0.12, height]),
      plank,
    )
  }
  g.box(
    root,
    'iron',
    f.block([-half + 0.07, half - 0.07], [-depth + 0.07, depth - 0.07], [0.12, height - 0.14]),
    [0.1, 0.12, 0.1],
  )
  for (const a of [-half + 0.3, half - 0.36]) {
    g.box(
      root,
      'iron',
      f.block([a, a + 0.06], [-depth - 0.01, depth + 0.01], [height - 0.18, height - 0.1]),
      IRON,
    )
  }
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

/** Plank-sided freight boxcar on two four-wheel trucks, with door, roofwalk and ladders. */
export function boxcar(g: FrontierGeometry, root: Node, c: Placement) {
  const f = frame(c)
  const height = c.top - f.base
  const half = f.length / 2
  const depth = f.width / 2
  const deck = 1.05
  g.box(
    root,
    'wood',
    f.block([-half, half], [-depth + 0.1, depth - 0.1], [deck - 0.2, deck]),
    [0.22, 0.19, 0.16],
  )
  g.box(
    root,
    'wood',
    f.block([-half + 0.1, half - 0.1], [-depth, depth], [deck, height - 0.18]),
    [0.47, 0.25, 0.17],
  )
  g.box(
    root,
    'wood',
    f.block([-half, half], [-depth - 0.02, depth + 0.02], [height - 0.18, height - 0.1]),
    [0.3, 0.2, 0.15],
  )
  g.box(
    root,
    'floor',
    f.block([-half + 0.2, half - 0.2], [-0.3, 0.3], [height - 0.1, height]),
    [0.4, 0.31, 0.22],
  )
  for (const side of [-1, 1]) {
    const face = side * depth
    const [b0, b1] = side < 0 ? [face - 0.05, face] : [face, face + 0.05]
    g.box(
      root,
      'wood',
      f.block([-0.95, 0.95], [b0, b1], [deck + 0.05, height - 0.35]),
      [0.42, 0.22, 0.15],
    )
    for (const a of [-0.95, -0.05, 0.85]) {
      g.box(
        root,
        'iron',
        f.block([a, a + 0.1], [b0 - side * 0.01, b1 + side * 0.01], [deck + 0.05, height - 0.35]),
        IRON,
      )
    }
    for (let a = -half + 0.6; a < half - 0.4; a += 1.6) {
      if (Math.abs(a) > 1.1) {
        g.box(
          root,
          'iron',
          f.block([a, a + 0.07], [b0, b1], [deck, height - 0.18]),
          [0.28, 0.2, 0.16],
        )
      }
    }
  }
  for (const end of [-half + 1.5, half - 1.5]) {
    g.box(
      root,
      'iron',
      f.block([end - 1.0, end + 1.0], [-depth + 0.25, depth - 0.25], [0.42, 0.62]),
      IRON,
    )
    for (const a of [end - 0.7, end + 0.7]) {
      tube(g, root, {
        role: 'iron',
        tint: IRON,
        from: f.point(a, -depth + 0.2, 0.42),
        to: f.point(a, depth - 0.2, 0.42),
        radius: 0.06,
      })
      for (const b of [-depth + 0.3, depth - 0.3]) {
        wheel(g, root, { center: f.point(a, b, 0.42), axis: f.acrossAxis, radius: 0.42, spokes: 8 })
      }
    }
  }
}

function hash(a: number, b: number) {
  const value = Math.sin(a * 91.7 + b * 47.3) * 15_731.743
  return value - Math.floor(value)
}
