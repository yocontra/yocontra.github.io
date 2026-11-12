import type { Node } from '@gltf-transform/core'
import {
  CANOPY_SEGMENTS,
  WAGON_BED,
  WAGON_WHEEL,
} from '../../src/experiments/out-west/ffa/sim/cover-shape.ts'
import type { Cover } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { frame, tube, wagonGear } from './frontier-carpentry.ts'
import { fenceSpans, wagonCanopy } from './frontier-collision.ts'
import type { PrefabFit } from './frontier-fit.ts'
import {
  anvil,
  bench,
  boxcar,
  DARK_WOOD,
  headstone,
  IRON,
  lumber,
  safe,
  stove,
  table,
  trough,
} from './frontier-furniture.ts'
import type { FrontierGeometry, Placement, Rgb } from './frontier-geometry.ts'

/** Library props whose authored proportions can fill their cover volume by repetition. */
const KIT_PROPS: Partial<Record<Cover['kind'], [string, PrefabFit]>> = {
  barrel_rack: ['k_barrel_rack', { tile: true, copyCost: 0.12 }],
  barrels: ['barrel', { tile: true, jitter: Math.PI }],
  bucket: ['k_bucket', { jitter: 0.6 }],
  lantern: ['lantern', {}],
  coffins: ['coffin', { anisotropy: 1.15 }],
  crates: ['k_crate_big', { tile: true, jitter: 0.06 }],
  workbench: ['k_workbench', { tile: true, anisotropy: 1.15 }],
}
const JOINERY: Partial<
  Record<Cover['kind'], (g: FrontierGeometry, root: Node, c: Placement) => void>
> = {
  anvil,
  bench,
  boxcar,
  headstone,
  lumber,
  safe,
  stove,
  table,
  trough,
}

export function coverModel(g: FrontierGeometry, root: Node, c: Cover) {
  const top = c.top ?? 1
  const area: Placement = { ...c, top }
  if (c.kind === 'hay') {
    hayBales(g, root, area)
    return
  }
  const prefab = KIT_PROPS[c.kind]
  if (prefab) {
    g.prefab(root, prefab[0], area, prefab[1])
    return
  }
  const joinery = JOINERY[c.kind]
  if (joinery) {
    joinery(g, root, area)
    return
  }
  if (c.kind === 'counter') {
    counterModel(g, root, area)
    return
  }
  if (c.kind === 'crate_stack') {
    crateStack(g, root, area)
    return
  }
  if (['wagon', 'freight_wagon', 'covered_wagon', 'stagecoach', 'wreck'].includes(c.kind)) {
    wagonModel(g, root, c)
    return
  }
  if (c.kind === 'fence' || c.kind === 'bars') {
    fenceModel(g, root, c)
    return
  }
  if (c.kind === 'shelves') {
    shelves(g, root, area)
    return
  }
  if (c.kind === 'piano') {
    piano(g, root, area)
    return
  }
  if (c.kind === 'bed') {
    g.box(root, 'wood', { ...area, top: (c.y0 ?? 0) + 0.25 }, [0.44, 0.29, 0.18])
    g.box(root, 'cloth', { ...area, y0: (c.y0 ?? 0) + 0.25, top }, [0.76, 0.66, 0.47])
    return
  }
  // Shop fixtures have intentional broad collision faces.
  g.box(root, c.kind === 'forge' ? 'stone' : 'wood', area, [0.57, 0.43, 0.29])
}

/** Tied straw bales fill the authored cover volume; the old cinched spool read as a placeholder. */
function hayBales(g: FrontierGeometry, root: Node, area: Placement) {
  const bottom = area.y0 ?? 0
  const columns = Math.max(1, Math.round(area.w / 1.05))
  const rows = Math.max(1, Math.round(area.d / 0.8))
  const layers = Math.max(1, Math.round((area.top - bottom) / 0.5))
  const w = area.w / columns
  const d = area.d / rows
  const h = (area.top - bottom) / layers
  for (let level = 0; level < layers; level++) {
    for (let col = 0; col < columns; col++) {
      for (let row = 0; row < rows; row++) {
        const x = area.x + col * w
        const z = area.z + row * d
        const y = bottom + level * h
        g.box(root, 'straw', { x, z, w, d, y0: y, top: y + h }, [0.86, 0.7, 0.35])
        for (const fraction of [0.26, 0.74]) {
          const band = x + w * fraction
          const tint: Rgb = [0.23, 0.18, 0.09]
          g.box(
            root,
            'straw',
            { x: band, z: z - 0.003, w: 0.025, d: 0.012, y0: y, top: y + h },
            tint,
          )
          g.box(
            root,
            'straw',
            { x: band, z: z + d - 0.009, w: 0.025, d: 0.012, y0: y, top: y + h },
            tint,
          )
          g.box(
            root,
            'straw',
            { x: band, z, w: 0.025, d, y0: y + h - 0.003, top: y + h + 0.003 },
            tint,
          )
        }
      }
    }
  }
}

/** Stacked freight crates at their authored size; the stack fills its collision volume. */
function crateStack(g: FrontierGeometry, root: Node, c: Placement) {
  g.prefab(root, 'k_crate_big', c, { tile: true, jitter: 0.05, hollow: true, copyCost: 0.08 })
}

/**
 * Wagons are built to their collision: the covered wagon follows the shared bed, wheel,
 * tongue and canopy profile; box-collided wagons keep wheels and sideboards inside the box.
 */
function wagonModel(g: FrontierGeometry, root: Node, c: Cover) {
  const f = frame(c)
  const top = (c.top ?? 1) - f.base
  if (c.kind === 'covered_wagon') {
    wagonGear(g, root, c, {
      bedCenter: 0.45,
      bedLength: f.length - 1.1,
      bedWidth: f.width - 0.5,
      bedTop: WAGON_BED + 0.12,
      sideRise: 0.4,
      wheelRadius: WAGON_WHEEL,
      wheelInset: 0.08,
    })
    g.surface(root, 'cloth', wagonCanopy(c))
    for (let i = 1; i < 5; i++) {
      const a = 0.45 + (i / 5 - 0.5) * (f.length - 1.35)
      const bows = Array.from({ length: CANOPY_SEGMENTS + 1 }, (_, j) => j / CANOPY_SEGMENTS)
      for (let j = 0; j < bows.length - 1; j++) {
        const at = (t: number) => {
          const theta = t * Math.PI
          const radius = Math.max(0.45, (f.width - 0.5) / 2) - 0.04
          const eave = WAGON_BED + 0.12 + 0.38
          return f.point(a, Math.cos(theta) * radius, eave + Math.sin(theta) * (top - eave - 0.06))
        }
        tube(g, root, {
          role: 'wood',
          tint: DARK_WOOD,
          from: at(bows[j] ?? 0),
          to: at(bows[j + 1] ?? 0),
          radius: 0.025,
          segments: 5,
        })
      }
    }
    return
  }
  const wheelRadius = Math.min(0.55, (top - 0.1) / 2)
  const bedTop = Math.min(top - 0.35, wheelRadius * 2 - 0.15)
  wagonGear(g, root, c, {
    bedCenter: 0.45,
    bedLength: f.length - 1.1,
    bedWidth: f.width - 0.4,
    bedTop,
    sideRise: c.kind === 'stagecoach' ? 0 : top - bedTop,
    wheelRadius,
    wheelInset: 0.08,
  })
  if (c.kind === 'stagecoach') {
    const a0 = -0.35
    const a1 = f.length / 2 - 0.25
    const half = f.width / 2 - 0.3
    const roof = top - 0.22
    const paint: Rgb = [0.46, 0.14, 0.09]
    g.box(root, 'wood', f.block([a0, a1], [-half, half], [bedTop, roof]), paint)
    g.box(
      root,
      'wood',
      f.block([a0 - 0.1, a1 + 0.1], [-half - 0.08, half + 0.08], [roof, roof + 0.06]),
      [0.2, 0.15, 0.11],
    )
    for (const b of [-half - 0.01, half - 0.02]) {
      for (const a of [a0 + 0.25, a1 - 0.85]) {
        g.box(
          root,
          'wood',
          f.block([a, a + 0.6], [b, b + 0.03], [bedTop + 0.65, roof - 0.2]),
          [0.07, 0.06, 0.05],
        )
      }
      g.box(
        root,
        'wood',
        f.block([a0, a1], [b - 0.01, b + 0.04], [bedTop + 0.55, bedTop + 0.6]),
        [0.72, 0.55, 0.22],
      )
    }
    for (const b of [-half, half - 0.05]) {
      g.box(root, 'iron', f.block([a0, a1], [b, b + 0.05], [roof + 0.06, top - 0.04]), IRON)
    }
    g.box(root, 'iron', f.block([a0, a1], [-half, half], [top - 0.04, top]), IRON)
    g.box(
      root,
      'wood',
      f.block([a0 - 0.9, a0], [-half + 0.1, half - 0.1], [bedTop, bedTop + 0.5]),
      paint,
    )
    g.box(
      root,
      'floor',
      f.block([a0 - 0.8, a0 - 0.2], [-half + 0.1, half - 0.1], [bedTop + 0.5, bedTop + 0.58]),
      [0.3, 0.2, 0.13],
    )
  }
}

function fenceModel(g: FrontierGeometry, root: Node, c: Cover) {
  for (const span of fenceSpans(c)) {
    g.box(
      root,
      c.kind === 'bars' ? 'iron' : 'wood',
      { ...span, top: span.y1 },
      c.kind === 'bars' ? [0.45, 0.48, 0.49] : [0.62, 0.51, 0.36],
    )
  }
}

function shelves(g: FrontierGeometry, root: Node, c: Placement) {
  const y = c.y0 ?? 0
  for (let tier = 0; tier < 4; tier++) {
    const h = y + ((c.top - y) * tier) / 3
    g.box(root, 'wood', { ...c, y0: h, top: h + 0.07 }, [0.42, 0.3, 0.19])
  }
  for (const x of [c.x, c.x + c.w - 0.09]) {
    for (const z of [c.z, c.z + c.d - 0.09]) {
      g.box(root, 'wood', { x, z, w: 0.09, d: 0.09, y0: y, top: c.top }, [0.38, 0.27, 0.17])
    }
  }
  const horizontal = c.w > c.d
  for (let i = 0; i < Math.max(c.w, c.d); i += 0.7) {
    g.prefab(root, 'k_bottle', {
      x: c.x + (horizontal ? i : 0.1),
      z: c.z + (horizontal ? 0.1 : i),
      w: 0.18,
      d: 0.18,
      y0: y + (c.top - y) / 3 + 0.08,
      top: y + (c.top - y) / 3 + 0.4,
    })
  }
}
function piano(g: FrontierGeometry, root: Node, c: Placement) {
  const y = c.y0 ?? 0
  g.box(root, 'wood', c, [0.22, 0.15, 0.11])
  const horizontal = c.w >= c.d
  const keys = 20
  for (let key = 0; key < keys; key++) {
    const width = (horizontal ? c.w : c.d) / keys
    const x = horizontal ? c.x + key * width : c.x + c.w - 0.27
    const z = horizontal ? c.z + c.d - 0.27 : c.z + key * width
    g.box(
      root,
      'wood',
      {
        x,
        z,
        w: horizontal ? width - 0.01 : 0.3,
        d: horizontal ? 0.3 : width - 0.01,
        y0: y + (c.top - y) * 0.65,
        top: y + (c.top - y) * 0.65 + 0.05,
      },
      key % 3 === 1 ? [0.12, 0.1, 0.09] : [0.95, 0.91, 0.76],
    )
  }
}

function counterModel(g: FrontierGeometry, root: Node, c: Placement) {
  const bottom = c.y0 ?? 0
  g.box(root, 'wood', { ...c, top: c.top - 0.12 }, [0.62, 0.43, 0.25])
  g.box(
    root,
    'floor',
    { x: c.x - 0.04, z: c.z - 0.04, w: c.w + 0.08, d: c.d + 0.08, y0: c.top - 0.12, top: c.top },
    [0.81, 0.66, 0.43],
  )
  const horizontal = c.w >= c.d
  const length = horizontal ? c.w : c.d
  for (let along = 0.08; along < length; along += 0.85) {
    g.box(
      root,
      'wood',
      {
        x: c.x + (horizontal ? along : -0.025),
        z: c.z + (horizontal ? -0.025 : along),
        w: horizontal ? 0.07 : c.w + 0.05,
        d: horizontal ? c.d + 0.05 : 0.07,
        y0: bottom + 0.08,
        top: c.top - 0.15,
      },
      [0.83, 0.65, 0.39],
    )
  }
}
