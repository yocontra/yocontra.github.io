import type { Node } from '@gltf-transform/core'
import type { Cover } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { fenceSpans, wagonCanopy } from './frontier-collision.ts'
import type { FrontierGeometry, Placement, Rgb } from './frontier-geometry.ts'

const KIT_PROPS: Partial<Record<Cover['kind'], string>> = {
  anvil: 'k_anvil',
  barrel_rack: 'k_barrel_rack',
  barrels: 'barrel',
  bucket: 'k_bucket',
  lantern: 'k_lantern',
  bench: 'k_bench',
  coffins: 'coffin',
  crates: 'k_crate_big',
  workbench: 'k_workbench',
  table: 'k_table',
  hay: 'hay',
  safe: 'k_chest',
  headstone: 'coffin',
}

export function coverModel(g: FrontierGeometry, root: Node, c: Cover) {
  const top = c.top ?? 1
  const area: Placement = { ...c, top }
  const prefab = KIT_PROPS[c.kind]
  if (prefab) {
    g.prefab(root, prefab, area)
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
  // Shop fixtures have intentional broad collision faces; open furniture uses the original Kit.
  const tint: Rgb = c.kind === 'boxcar' ? [0.38, 0.32, 0.25] : [0.57, 0.43, 0.29]
  g.box(root, c.kind === 'forge' || c.kind === 'headstone' ? 'stone' : 'wood', area, tint)
  if (c.kind === 'boxcar') {
    for (const z of [c.z + 0.1, c.z + c.d - 0.1]) {
      g.box(root, 'wood', { x: c.x, z, w: c.w, d: 0.13, y0: 0.3, top: 0.52 }, [0.19, 0.17, 0.15])
    }
  }
}

function crateStack(g: FrontierGeometry, root: Node, c: Placement) {
  const top = c.top
  {
    const rows = Math.max(1, Math.ceil((top - (c.y0 ?? 0)) / 1.4))
    const columns = Math.max(1, Math.ceil(c.w / 2))
    const depth = Math.max(1, Math.ceil(c.d / 2))
    for (let level = 0; level < rows; level++) {
      for (let col = 0; col < columns; col++) {
        for (let row = 0; row < depth; row++) {
          const y = (c.y0 ?? 0) + ((top - (c.y0 ?? 0)) * level) / rows
          g.prefab(root, 'k_crate_big', {
            x: c.x + (c.w * col) / columns,
            z: c.z + (c.d * row) / depth,
            w: c.w / columns,
            d: c.d / depth,
            y0: y,
            top: y + (top - (c.y0 ?? 0)) / rows,
          })
        }
      }
    }
  }
}

function wagonModel(g: FrontierGeometry, root: Node, c: Cover) {
  const top = c.top ?? 1
  const area: Placement = { ...c, top }
  g.prefab(root, 'cart', { ...area, top: c.kind === 'covered_wagon' ? 1.25 : top })
  if (c.kind === 'covered_wagon') {
    g.surface(root, 'cloth', wagonCanopy(c))
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
