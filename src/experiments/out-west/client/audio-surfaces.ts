/**
 * What a bullet or a boot meets, read from the same authored layout the scene and the native
 * collision are built from: buildings (stone for the bank, jail, church and tower, timber for the
 * rest), every cover kind, porch decks, stairs, upper floors, roofs, window glass and the creek.
 */
import {
  type Building,
  type Cover,
  type CoverKind,
  type Grid,
  type Surface,
  TOWN,
  type TownLayout,
} from '../ffa/sim/layout.ts'
import { surfaceTop } from '../ffa/sim/surfaces.ts'

export type ImpactMaterial =
  | 'body'
  | 'wood'
  | 'stone'
  | 'metal'
  | 'glass'
  | 'dirt'
  | 'water'
  | 'soft'
export type StepSurface = 'dirt' | 'wood' | 'stone' | 'metal' | 'straw' | 'water'

const STONE_BUILDINGS: ReadonlySet<string> = new Set(['bank', 'jail', 'church', 'tower'])
/** Floors laid with straw rather than boards. */
const STRAW_BUILDINGS: ReadonlySet<string> = new Set(['barn', 'stable'])
/** Flagged floors inside the masonry buildings that have them. */
const STONE_FLOORS: ReadonlySet<string> = new Set(['bank', 'jail'])

const COVER_MATERIAL: Partial<Record<CoverKind, ImpactMaterial>> = {
  anvil: 'metal',
  bars: 'metal',
  bucket: 'metal',
  buffer: 'metal',
  lantern: 'metal',
  safe: 'metal',
  stove: 'metal',
  forge: 'stone',
  headstone: 'stone',
  well: 'stone',
  bed: 'soft',
  hay: 'soft',
}
/** Water-filled cover: a shot into the top of it splashes. */
const WATER_TOPS: ReadonlySet<CoverKind> = new Set(['trough', 'bucket', 'well'])
const COVER_STEP: Partial<Record<CoverKind, StepSurface>> = {
  boxcar: 'metal',
  safe: 'metal',
  stove: 'metal',
  forge: 'stone',
  well: 'stone',
  hay: 'straw',
}

/** A round into the floor strikes what a boot would stand on there. */
const GROUND_HIT: Readonly<Record<StepSurface, ImpactMaterial>> = {
  dirt: 'dirt',
  wood: 'wood',
  stone: 'stone',
  metal: 'metal',
  straw: 'soft',
  water: 'water',
}

/** How close (m) a point must be to a face to count as hitting it. */
const SKIN = 0.35
const GROUND = 0.15

const inside = (r: { x: number; z: number; w: number; d: number }, x: number, z: number, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && z >= r.z - pad && z <= r.z + r.d + pad

function buildingAt(layout: TownLayout, x: number, z: number, pad: number): Building | undefined {
  return layout.buildings.find((b) => inside(b, x, z, pad))
}

function coverAt(layout: TownLayout, x: number, y: number, z: number): Cover | undefined {
  return layout.cover.find((c) => {
    const y0 = c.y0 ?? 0
    const top = y0 + (c.top ?? (c.low ? 1.1 : 3.5))
    return inside(c, x, z, SKIN * 0.6) && y >= y0 - 0.1 && y <= top + 0.15
  })
}

function coverMaterial(c: Cover, y: number): ImpactMaterial {
  const top = (c.y0 ?? 0) + (c.top ?? 1)
  if (WATER_TOPS.has(c.kind) && y > top - 0.15) {
    return 'water'
  }
  if (c.kind === 'boxcar' && y - (c.y0 ?? 0) < 1) {
    // the iron trucks and couplers under the timber body
    return 'metal'
  }
  return COVER_MATERIAL[c.kind] ?? 'wood'
}

function nearGlass(grid: Grid | undefined, x: number, y: number, z: number): boolean {
  if (!grid) {
    return false
  }
  return grid.glass.some((g) => {
    const across = g.axis === 0 ? x : z
    const along = g.axis === 0 ? z : x
    return Math.abs(across - g.at) < 0.2 && along >= g.a0 && along <= g.a1 && y >= g.y0 && y <= g.y1
  })
}

function onSlab(list: readonly Surface[], x: number, y: number, z: number): boolean {
  return list.some((s) => inside(s, x, z, 0.05) && Math.abs(surfaceTop(s, x, z) - y) < 0.3)
}

/** The material at the end of a shot that hit scenery (not a rider); null when it hit nothing. */
export function impactMaterial(
  at: { x: number; y: number; z: number },
  grid?: Grid,
  layout: TownLayout = TOWN,
): ImpactMaterial | null {
  const { x, y, z } = at
  if (nearGlass(grid, x, y, z)) {
    return 'glass'
  }
  const cover = coverAt(layout, x, y, z)
  if (cover) {
    return coverMaterial(cover, y)
  }
  if (y < GROUND) {
    return GROUND_HIT[stepSurface(x, y, z, layout)]
  }
  if (grid && (onSlab(grid.decks, x, y, z) || onSlab(grid.stairs, x, y, z))) {
    return 'wood'
  }
  const building = buildingAt(layout, x, z, SKIN)
  if (building) {
    if (y > building.height + 0.2) {
      // shingles and roof boards
      return 'wood'
    }
    const face =
      Math.min(
        Math.abs(x - building.x),
        Math.abs(x - building.x - building.w),
        Math.abs(z - building.z),
        Math.abs(z - building.z - building.d),
      ) <
      SKIN + 0.3
    // the masonry is the shell; partitions, floors and fittings inside are timber
    return STONE_BUILDINGS.has(building.kind) && face ? 'stone' : 'wood'
  }
  if (grid && (onSlab(grid.overheads, x, y, z) || onSlab(grid.roofs, x, y, z))) {
    return 'wood'
  }
  return y < 0.5 ? 'dirt' : null
}

/** What a rider standing with feet at (x, y, z) is standing on. */
export function stepSurface(
  x: number,
  y: number,
  z: number,
  layout: TownLayout = TOWN,
): StepSurface {
  if (y < GROUND) {
    if (inside(layout.creek, x, z) && !inside(layout.creek.bridge, x, z)) {
      return 'water'
    }
    const building = buildingAt(layout, x, z, -0.3)
    if (building?.hollow) {
      if (STRAW_BUILDINGS.has(building.kind)) {
        return 'straw'
      }
      return STONE_FLOORS.has(building.kind) ? 'stone' : 'wood'
    }
    return inside(layout.creek.bridge, x, z) ? 'wood' : 'dirt'
  }
  const cover = layout.cover.find(
    (c) => inside(c, x, z, 0.1) && Math.abs((c.y0 ?? 0) + (c.top ?? 0) - y) < 0.35,
  )
  if (cover) {
    return COVER_STEP[cover.kind] ?? 'wood'
  }
  return 'wood'
}
