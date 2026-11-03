// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: placement loops over layout rects
// biome-ignore-all lint/complexity/useMaxParams: placement helpers take positional numeric args
/**
 * Cover and set dressing from the layout: every cover rect is filled with props that match its
 * footprint (it is exactly what blocks movement and bullets on the server). Props from the shared
 * GLB are instanced per type; troughs and boxcars are built into the wood geometry. Rocks, cacti
 * and the boundary fence come from `outskirts.ts` (seeded clumps, never rows).
 */
import type { Matrix4, Object3D } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GeoBuilder } from '../../scene/geo.ts'
import { instance, placeMatrix, propDef } from '../../scene/props.ts'
import type { Cover, TownLayout } from '../sim/layout.ts'
import { OUTSKIRTS_SEED, outskirtsProps } from './outskirts.ts'

/** Deterministic jitter so the town looks the same for everyone. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10_000) / 10_000
  }
}

interface Placements {
  barrel: Matrix4[]
  crate: Matrix4[]
  hay: Matrix4[]
  fence: Matrix4[]
  cart: Matrix4[]
  rock: Matrix4[]
  cactus: Matrix4[]
}

function fillRect(c: Cover, spacing: number, cb: (x: number, z: number) => void): void {
  const nx = Math.max(1, Math.round(c.w / spacing))
  const nz = Math.max(1, Math.round(c.d / spacing))
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      cb(c.x + ((i + 0.5) * c.w) / nx, c.z + ((j + 0.5) * c.d) / nz)
    }
  }
}

function place(c: Cover, p: Placements, wood: GeoBuilder, r: () => number): void {
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const alongX = c.w >= c.d
  switch (c.kind) {
    case 'barrels':
      fillRect(c, 0.75, (x, z) => p.barrel.push(placeMatrix(x, 0, z, r() * 6, 0.95 + r() * 0.1)))
      break
    case 'crates':
      fillRect(c, 0.75, (x, z) => {
        p.crate.push(placeMatrix(x, 0, z, (r() - 0.5) * 0.4))
        if (r() < 0.5) {
          p.crate.push(placeMatrix(x, 0.72, z, (r() - 0.5) * 0.8, 0.9))
        }
      })
      break
    case 'hay':
      fillRect(c, 1.1, (x, z) => p.hay.push(placeMatrix(x, 0, z, alongX ? 0 : Math.PI / 2)))
      break
    case 'fence': {
      const len = Math.max(c.w, c.d)
      const n = Math.max(1, Math.round(len / 2))
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n
        const x = alongX ? c.x + t * c.w : cx
        const z = alongX ? cz : c.z + t * c.d
        p.fence.push(placeMatrix(x, 0, z, alongX ? 0 : Math.PI / 2))
      }
      break
    }
    case 'wagon':
      p.cart.push(placeMatrix(cx, 0, cz, alongX ? Math.PI / 2 : 0, 1))
      break
    case 'trough':
      wood.box(cx, 0.35, cz, c.w, 0.7, c.d, 0x6a_4c_34)
      wood.box(cx, 0.66, cz, c.w - 0.2, 0.04, c.d - 0.2, 0x3a_5a_60, { skip: ['bottom'] })
      break
    case 'boxcar':
      wood.box(cx, 2.05, cz, c.w, 2.9, c.d, 0x7a_2e_22)
      wood.box(cx, 3.6, cz, c.w + 0.2, 0.2, c.d + 0.3, 0x3a_30_2a)
      wood.box(
        cx,
        0.3,
        cz,
        alongX ? c.w - 1 : c.d * 0.8,
        0.6,
        alongX ? c.d * 0.8 : c.d - 1,
        0x22_20_1e,
      )
      break
    default:
      break
  }
}

/** Rails under the boxcars of the depot yard. */
function rails(layout: TownLayout, wood: GeoBuilder): void {
  for (const c of layout.cover) {
    if (c.kind !== 'boxcar') {
      continue
    }
    const alongX = c.w >= c.d
    const cx = c.x + c.w / 2
    const cz = c.z + c.d / 2
    const len = 40
    for (const off of [-0.72, 0.72]) {
      wood.box(
        alongX ? cx : cx + off,
        0.06,
        alongX ? cz + off : cz,
        alongX ? len : 0.1,
        0.12,
        alongX ? 0.1 : len,
        0x5a_56_52,
      )
    }
    for (let t = -len / 2; t < len / 2; t += 0.9) {
      wood.box(
        alongX ? cx + t : cx,
        0.03,
        alongX ? cz : cz + t,
        alongX ? 0.3 : 2.2,
        0.06,
        alongX ? 2.2 : 0.3,
        0x4a_3a_2c,
      )
    }
  }
}

export function dressCover(
  layout: TownLayout,
  props: GLTF,
  parent: Object3D,
  wood: GeoBuilder,
): void {
  const r = rand(0x70_57)
  const p: Placements = {
    barrel: [],
    crate: [],
    hay: [],
    fence: [],
    cart: [],
    rock: [],
    cactus: [],
  }
  for (const c of layout.cover) {
    place(c, p, wood, r)
  }
  rails(layout, wood)
  const land = outskirtsProps(layout, OUTSKIRTS_SEED)
  p.rock.push(...land.rock)
  p.cactus.push(...land.cactus)
  p.fence.push(...land.fence)
  const add = (
    name: string,
    size: number,
    mats: Matrix4[],
    axis: 'max' | 'y' | 'x' | 'z' = 'max',
  ) => {
    if (mats.length === 0) {
      return
    }
    const def = propDef(props, name, size, axis)
    if (def) {
      // Static and low: their shadows are in the baked ground mask, not the real-time map.
      instance(def, mats, parent, false)
    }
  }
  add('barrel', 0.95, p.barrel, 'y')
  add('crate', 0.72, p.crate, 'y')
  add('hay', 1.0, p.hay, 'x')
  add('fence', 2.0, p.fence, 'x')
  add('cart', 3.8, p.cart, 'max')
  add('rock', 1.2, p.rock, 'max')
  add('cactus', 2.4, p.cactus, 'y')
}
