// biome-ignore-all lint/style/noExcessiveLinesPerFile: the layout, the grid and its surfaces are one source of truth
// biome-ignore-all lint/complexity/useMaxParams: grid builders take positional numeric args
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the grid sweep and surface build are one pass
// biome-ignore-all lint/style/noNestedTernary: stair directions read as a small switch
/**
 * The town layout (`ffa/town.layout.json`) and the collision grid built from it. The JSON is the
 * single source of truth: the server and the client build the same grid from it here, and the
 * Blender build and the client scene read the same file.
 */
import townJson from '../town.layout.json' with { type: 'json' }
import { type GlassPlane, townWindows, type WindowOpening, windowPane } from './building-rules.ts'
import { type ShapedCover, shapedCover } from './cover-shape.ts'
import {
  frontOf,
  PLATFORM_DEPTH,
  PORCH_DEPTH,
  PORCH_ROOF,
  PORCH_ROOF_T,
  PORCHED,
  sideStrip,
  UPPER_FLOOR_T,
} from './porches.ts'
import { roofHeightAt, roofSlopeAt } from './roofshape.ts'

export interface Rect {
  x: number
  z: number
  w: number
  d: number
}
export type Side = 'n' | 's' | 'e' | 'w'

/** Every building kind in `town.layout.json`. Closed: a new kind is a deliberate edit here. */
export const BUILDING_KINDS = [
  'assay',
  'bank',
  'barn',
  'church',
  'depot',
  'general_store',
  'hotel',
  'jail',
  'outhouse',
  'saloon',
  'shed',
  'smithy',
  'stable',
  'stage_line',
  'tower',
  'undertaker',
  'water_tower',
] as const
export type BuildingKind = (typeof BUILDING_KINDS)[number]

/** Every cover kind in `town.layout.json` (fences, furniture, wagons, wrecks). */
export const COVER_KINDS = [
  'anvil',
  'barrel_rack',
  'barrels',
  'bars',
  'bed',
  'bench',
  'boxcar',
  'bridge_rail',
  'buffer',
  'coffins',
  'counter',
  'covered_wagon',
  'crate_stack',
  'crates',
  'fence',
  'forge',
  'freight_wagon',
  'hay',
  'headstone',
  'hitch_rail',
  'lumber',
  'piano',
  'pole',
  'post',
  'safe',
  'shelves',
  'stagecoach',
  'stove',
  'table',
  'trough',
  'wagon',
  'well',
  'woodpile',
  'workbench',
  'wreck',
] as const
export type CoverKind = (typeof COVER_KINDS)[number]

export const ZONE_KINDS = ['bank', 'stage'] as const
export type ZoneKind = (typeof ZONE_KINDS)[number]
export interface Door {
  side: Side
  /** Offset of the gap from the wall's west (n/s) or north (e/w) end, in metres. */
  at: number
  width: number
}
export interface Wall extends Rect {
  /** Bottom of the wall span, metres (default 0: a ground-floor partition). */
  y0?: number
  /** Top of the wall span, metres (default the building's height). */
  y1?: number
}
export interface Stair extends Rect {
  /** Bottom and top of the ramp, metres. */
  fromY: number
  toY: number
  /** The direction the stair climbs toward. */
  dir: Side
}
export interface Floor extends Rect {
  /** Top of the floor boards, metres. */
  y: number
}
export interface RoofSpec {
  /** Ridge direction. */
  axis: 'x' | 'z'
  /** Ridge height above the wall top. */
  rise: number
  /** Side-by-side gables across the span. */
  bays: number
  overhang: number
  /** The end hidden by a false front: no overhang, no gable wall. */
  front: Side | null
}
export interface Building extends Rect {
  id: string
  kind: BuildingKind
  height: number
  floors: number
  /** Hollow buildings are walkable inside: 0.5 m perimeter walls with door gaps. */
  hollow: boolean
  doors: Door[]
  /** Interior partitions (hollow buildings only). */
  walls?: Wall[]
  /** The side its facade faces, where the nearest street doesn't say (depot on the track, sheds). */
  front?: Side
  /** The pitched roof shape (the sim walks on it, the scene builds it). */
  roof?: RoofSpec
  /** Real second-floor boards and the stairs that reach them. */
  upperFloor?: Floor[]
  stairs?: Stair[]
  /** Real wall openings: cut by the scene, seen and fired through by the sim. */
  windows?: WindowOpening[]
}
export interface Cover extends Rect {
  kind: CoverKind
  /** Low cover blocks movement and bullets but not sight. Tall cover (boxcars) blocks all three. */
  low: boolean
  /**
   * Low cover a rider can vault: the height of its top, metres (fences 1.1, hitching rails 1.05,
   * troughs 0.7...). Absent on tall cover and on low pieces that can't be vaulted (posts, wells).
   */
  vaultHeight?: number
  /** Top surface height, metres. Every cover carries it so the sim knows what to stand on. */
  top?: number
  /** Whether the top is wide enough to stand on (crates, wagons, boxcars; not fences or rails). */
  standable?: boolean
  /** Base height for furniture placed on an upper floor. */
  y0?: number
}
export interface Zone {
  id: string
  kind: ZoneKind
  x: number
  z: number
  r: number
}
export interface SpawnPoint {
  x: number
  z: number
  interior: boolean
}
export interface Spot {
  id: string
  x: number
  z: number
}
export interface PickupSpot extends Spot {
  kind: 'rifle' | 'shotgun' | 'dynamite'
}
export interface TownLayout {
  version: number
  name: string
  size: number
  cell: number
  streets: (Rect & { id: string })[]
  creek: Rect & { banks: Rect[]; bridge: Rect }
  buildings: Building[]
  cover: Cover[]
  zones: Zone[]
  spawns: SpawnPoint[]
  strongboxes: Spot[]
  pickups: PickupSpot[]
  /** The porch catwalk decks (mirrors `ROOF_WALKS`, written by the town plan). */
  catwalks?: { x: number; z: number; w: number; d: number; height: number }[]
}

export const TOWN: TownLayout = townJson as TownLayout

/**
 * The bank's deposit windows (inside the lobby, at the teller grilles): stand in one with money
 * and interact to bank it. For HUD arrows and onboarding.
 */
export const BANK_WINDOWS: readonly Zone[] = TOWN.zones.filter((z) => z.kind === 'bank')

export const BLOCK_MOVE = 1
export const BLOCK_SHOT = 2
export const BLOCK_SIGHT = 4
/**
 * Low cover a rider can vault (`Cover.vaultHeight`): blocks movement like any cover, except to a
 * vault. Never set on a cell that anything solid also fills.
 */
export const BLOCK_VAULT = 8
const WALL = BLOCK_MOVE | BLOCK_SHOT | BLOCK_SIGHT
const WALL_THICKNESS = 0.5
const EPS = 1e-6

/** A walkable or blocking surface in the 2.5D world. */
export interface Surface {
  x: number
  z: number
  w: number
  d: number
  /** Bottom of the solid span, metres. */
  bottom: number
  /** Top of the solid span, metres. */
  top: number
  kind: 'solid' | 'overhead' | 'roof' | 'stair' | 'rail'
  /** A pitched roof or stair: the top varies with (x, z). */
  heightAt?: ((x: number, z: number) => number) | undefined
  /** The surface's slope as rise/run, for the walkable-slope check. */
  slope?: number | undefined
}

export interface Grid {
  /** Cells per side. */
  n: number
  cell: number
  size: number
  cells: Uint8Array
  /** Interior rect of the bank building: leaving town in here banks your carry. */
  bankArea: Rect
  /** Top of the base solid per cell, metres (0 = open ground). */
  tops: Float32Array
  /** Exact cover profiles, indexed only in the cells they overlap; flat solids stay in tops. */
  shapeCells: (readonly ShapedCover[] | undefined)[]
  shaped: ShapedCover[]
  /** 1 where the base top is wide enough to stand on (crates, wagons, boxcars). */
  standable: Uint8Array
  /** Thin slabs you can walk under and stand on: porch roofs, catwalks, upper floors. */
  overheads: Surface[]
  /** Stairs and ramps. */
  stairs: Surface[]
  /** Pitched building roofs. */
  roofs: Surface[]
  /** Raised outdoor decks (porches, the depot platform), metres. */
  decks: Surface[]
  /** Static glass panes, one per window opening, indexed like `World.glass`. */
  glass: GlassPlane[]
  /** Real openings in hollow walls: 3D rays pass between `y0` and `y1`, movement still blocks. */
  windowHoles: WindowHole[]
  /** Per-cell bucket into `windowHoles`: `holeRefs[holeStarts[i]..holeStarts[i + 1]]`. */
  holeStarts: Int32Array
  holeRefs: Int32Array
}

/** A cut window opening, used only by 3D ray tests. */
export interface WindowHole extends Rect {
  /** Opening bottom/top, metres. */
  y0: number
  y1: number
}

function fill(grid: Grid, r: Rect, flags: number): void {
  if (r.w <= 0 || r.d <= 0) {
    return
  }
  const c0 = Math.max(0, Math.floor((r.x + EPS) / grid.cell))
  const c1 = Math.min(grid.n - 1, Math.ceil((r.x + r.w - EPS) / grid.cell) - 1)
  const r0 = Math.max(0, Math.floor((r.z + EPS) / grid.cell))
  const r1 = Math.min(grid.n - 1, Math.ceil((r.z + r.d - EPS) / grid.cell) - 1)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * grid.n + col
      grid.cells[i] = (grid.cells[i] ?? 0) | flags
    }
  }
}

/** One box of a building's wall: a rect plus its vertical span. */
export interface WallBox extends Rect {
  y0: number
  y1: number
}

/** The wall rect for one run along a side, metres from its west/north end. */
function sideWallRect(b: Building, side: Side, a0: number, a1: number): Rect {
  const horizontal = side === 'n' || side === 's'
  if (horizontal) {
    const zz = side === 'n' ? b.z : b.z + b.d - WALL_THICKNESS
    return { x: b.x + a0, z: zz, w: a1 - a0, d: WALL_THICKNESS }
  }
  const xx = side === 'w' ? b.x : b.x + b.w - WALL_THICKNESS
  return { x: xx, z: b.z + a0, w: WALL_THICKNESS, d: a1 - a0 }
}

/**
 * Split one exterior side into real wall boxes: full height between openings, and below/above
 * every window. Door gaps stay empty to the floor; window middles are the actual holes the scene
 * cuts and the sim looks through.
 */
export function buildingSideBoxes(b: Building, side: Side): WallBox[] {
  const horizontal = side === 'n' || side === 's'
  const len = horizontal ? b.w : b.d
  const gaps = b.doors
    .filter((d) => d.side === side)
    .map((d) => [d.at, d.at + d.width] as const)
    .toSorted((p, q) => p[0] - q[0])
  const windows = (b.windows ?? [])
    .filter((w) => w.side === side)
    .map((w) => [w.at, w.at + w.width, w.sill, w.top] as const)
    .toSorted((p, q) => p[0] - q[0])
  const pieces: [number, number][] = []
  let start = 0
  for (const [g0, g1] of gaps) {
    if (g0 > start) {
      pieces.push([start, g0])
    }
    start = Math.max(start, g1)
  }
  if (start < len) {
    pieces.push([start, len])
  }
  const out: WallBox[] = []
  for (const [a0, a1] of pieces) {
    const cuts = new Set<number>([a0, a1])
    for (const [w0, w1] of windows) {
      if (w1 > a0 && w0 < a1) {
        cuts.add(Math.max(a0, w0))
        cuts.add(Math.min(a1, w1))
      }
    }
    const xs = [...cuts].sort((p, q) => p - q)
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i] ?? a0
      const x1 = xs[i + 1] ?? a1
      if (x1 - x0 < 1e-6) {
        continue
      }
      const win = windows.find(([w0, w1]) => x0 >= w0 - 1e-6 && x1 <= w1 + 1e-6)
      if (win && b.hollow) {
        const [, , sill, top] = win
        if (sill > 0.01) {
          out.push({ ...sideWallRect(b, side, x0, x1), y0: 0, y1: sill })
        }
        if (top < b.height - 0.01) {
          out.push({ ...sideWallRect(b, side, x0, x1), y0: top, y1: b.height })
        }
      } else {
        out.push({ ...sideWallRect(b, side, x0, x1), y0: 0, y1: b.height })
      }
    }
  }
  return out
}

/** Split one wall segment around its door gaps. `along` is x for n/s walls, z for e/w walls. */
function wallWithGaps(b: Building, side: Side): Rect[] {
  const horizontal = side === 'n' || side === 's'
  const length = horizontal ? b.w : b.d
  const gaps = b.doors
    .filter((d) => d.side === side)
    .map((d) => [d.at, d.at + d.width] as const)
    .toSorted((p, q) => p[0] - q[0])
  const pieces: [number, number][] = []
  let start = 0
  for (const [g0, g1] of gaps) {
    if (g0 > start) {
      pieces.push([start, g0])
    }
    start = Math.max(start, g1)
  }
  if (start < length) {
    pieces.push([start, length])
  }
  return pieces.map(([a, z]) => {
    if (horizontal) {
      const zz = side === 'n' ? b.z : b.z + b.d - WALL_THICKNESS
      return { x: b.x + a, z: zz, w: z - a, d: WALL_THICKNESS }
    }
    const xx = side === 'w' ? b.x : b.x + b.w - WALL_THICKNESS
    return { x: xx, z: b.z + a, w: WALL_THICKNESS, d: z - a }
  })
}

/** Every ground-level blocking rect a building contributes (upper-floor walls live in surfaces). */
export function buildingWalls(b: Building): Rect[] {
  if (!b.hollow) {
    return [b]
  }
  const sides: Side[] = ['n', 's', 'e', 'w']
  const ground = (b.walls ?? []).filter((w) => (w.y0 ?? 0) <= 0.01)
  return [...sides.flatMap((side) => wallWithGaps(b, side)), ...ground]
}

/** Every wall span a building contributes, ground and upper floors. */
export function buildingWallSpans(b: Building): Wall[] {
  if (!b.hollow) {
    return [{ ...b, y0: 0, y1: b.height }]
  }
  const sides: Side[] = ['n', 's', 'e', 'w']
  return [
    ...sides.flatMap((side) =>
      wallWithGaps(b, side).map((r) => ({ ...r, y0: 0, y1: b.height }) as Wall),
    ),
    ...(b.walls ?? []).map((w) => ({ ...w, y0: w.y0 ?? 0, y1: w.y1 ?? b.height }) as Wall),
  ]
}

/** Clear flags from every cell a rect covers. */
function clearFlags(grid: Grid, r: Rect, flags: number): void {
  if (r.w <= 0 || r.d <= 0) {
    return
  }
  const c0 = Math.max(0, Math.floor((r.x + EPS) / grid.cell))
  const c1 = Math.min(grid.n - 1, Math.ceil((r.x + r.w - EPS) / grid.cell) - 1)
  const r0 = Math.max(0, Math.floor((r.z + EPS) / grid.cell))
  const r1 = Math.min(grid.n - 1, Math.ceil((r.z + r.d - EPS) / grid.cell) - 1)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * grid.n + col
      grid.cells[i] = (grid.cells[i] ?? 0) & ~flags
    }
  }
}

/** Set the top of the base solid in every cell a rect covers. */
function fillTop(grid: Grid, r: Rect, top: number): void {
  if (r.w <= 0 || r.d <= 0) {
    return
  }
  const c0 = Math.max(0, Math.floor((r.x + EPS) / grid.cell))
  const c1 = Math.min(grid.n - 1, Math.ceil((r.x + r.w - EPS) / grid.cell) - 1)
  const r0 = Math.max(0, Math.floor((r.z + EPS) / grid.cell))
  const r1 = Math.min(grid.n - 1, Math.ceil((r.z + r.d - EPS) / grid.cell) - 1)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * grid.n + col
      if (top > (grid.tops[i] ?? 0)) {
        grid.tops[i] = top
      }
    }
  }
}

/** Mark every cell a rect covers as standable. */
function fillStandable(grid: Grid, r: Rect): void {
  if (r.w <= 0 || r.d <= 0) {
    return
  }
  const c0 = Math.max(0, Math.floor((r.x + EPS) / grid.cell))
  const c1 = Math.min(grid.n - 1, Math.ceil((r.x + r.w - EPS) / grid.cell) - 1)
  const r0 = Math.max(0, Math.floor((r.z + EPS) / grid.cell))
  const r1 = Math.min(grid.n - 1, Math.ceil((r.z + r.d - EPS) / grid.cell) - 1)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      grid.standable[row * grid.n + col] = 1
    }
  }
}

const surface = (
  r: Rect,
  bottom: number,
  top: number,
  kind: Surface['kind'],
  heightAt?: (x: number, z: number) => number,
  slope?: number,
): Surface => ({ ...r, bottom, top, kind, heightAt, slope })

export function buildGrid(layout: TownLayout = TOWN): Grid {
  const n = Math.round(layout.size / layout.cell)
  const bank = layout.buildings.find((b) => b.kind === 'bank')
  const grid: Grid = {
    n,
    cell: layout.cell,
    size: layout.size,
    cells: new Uint8Array(n * n),
    tops: new Float32Array(n * n),
    shapeCells: new Array(n * n),
    shaped: [],
    standable: new Uint8Array(n * n),
    overheads: [],
    stairs: [],
    roofs: [],
    decks: [],
    glass: [],
    windowHoles: [],
    holeStarts: new Int32Array(n * n + 1),
    holeRefs: new Int32Array(0),
    bankArea: bank
      ? {
          x: bank.x + WALL_THICKNESS,
          z: bank.z + WALL_THICKNESS,
          w: bank.w - 2 * WALL_THICKNESS,
          d: bank.d - 2 * WALL_THICKNESS,
        }
      : { x: 0, z: 0, w: 0, d: 0 },
  }
  const s = layout.size
  // Map border, and the steep ground north of the creek bed.
  fill(grid, { x: 0, z: 0, w: s, d: Math.max(layout.cell, layout.creek.z) }, WALL)
  fill(grid, { x: 0, z: s - layout.cell, w: s, d: layout.cell }, WALL)
  fill(grid, { x: 0, z: 0, w: layout.cell, d: s }, WALL)
  fill(grid, { x: s - layout.cell, z: 0, w: layout.cell, d: s }, WALL)
  fillTop(grid, { x: 0, z: 0, w: s, d: Math.max(layout.cell, layout.creek.z) }, 12)
  fillTop(grid, { x: 0, z: s - layout.cell, w: s, d: layout.cell }, 12)
  fillTop(grid, { x: 0, z: 0, w: layout.cell, d: s }, 12)
  fillTop(grid, { x: s - layout.cell, z: 0, w: layout.cell, d: s }, 12)
  for (const bankEdge of layout.creek.banks) {
    fill(grid, bankEdge, BLOCK_MOVE)
  }
  for (const b of layout.buildings) {
    for (const r of buildingWalls(b)) {
      fill(grid, r, WALL)
      fillTop(grid, r, b.height)
    }
    // Real windows: movement still blocks on the wall cells; 3D rays pass through the opening
    // (see `windowHoles`), and sight ignores the pane. Glass below/above stays solid.
    if (b.hollow) {
      for (const w of b.windows ?? []) {
        clearFlags(grid, sideWallRect(b, w.side, w.at, w.at + w.width), BLOCK_SHOT | BLOCK_SIGHT)
      }
    }
    // Upper-floor walls are solid only above the ground floor.
    for (const w of b.walls ?? []) {
      if ((w.y0 ?? 0) > 0.01) {
        grid.overheads.push(surface(w, w.y0 ?? 0, w.y1 ?? b.height, 'rail'))
      }
    }
    // Porch roofs are thin slabs: walk under them, stand on them.
    if (PORCHED.has(b.kind)) {
      const strip = sideStrip(b, frontOf(b, layout), PORCH_DEPTH)
      grid.decks.push(surface(strip, 0, 0.06, 'solid'))
      grid.overheads.push(
        surface(strip, PORCH_ROOF - PORCH_ROOF_T / 2, PORCH_ROOF + PORCH_ROOF_T / 2, 'overhead'),
      )
    } else if (b.kind === 'depot') {
      const strip = sideStrip(b, frontOf(b, layout), PLATFORM_DEPTH)
      grid.decks.push(surface(strip, 0, 0.06, 'solid'))
    }
    // Real second floors.
    for (const f of b.upperFloor ?? []) {
      grid.overheads.push(surface(f, f.y - UPPER_FLOOR_T, f.y, 'overhead'))
    }
    for (const st of b.stairs ?? []) {
      const along = st.dir === 'n' || st.dir === 's' ? st.d : st.w
      const heightAt = (x: number, z: number): number => {
        const t =
          st.dir === 'n'
            ? (st.z + st.d - z) / Math.max(1e-6, along)
            : st.dir === 's'
              ? (z - st.z) / Math.max(1e-6, along)
              : st.dir === 'w'
                ? (st.x + st.w - x) / Math.max(1e-6, along)
                : (x - st.x) / Math.max(1e-6, along)
        return st.fromY + (st.toY - st.fromY) * Math.max(0, Math.min(1, t))
      }
      grid.stairs.push(
        surface(
          st,
          st.fromY,
          st.toY,
          'stair',
          heightAt,
          Math.abs(st.toY - st.fromY) / Math.max(1e-6, along),
        ),
      )
    }
    // Pitched roof: a walkable surface over the footprint plus the eave overhang.
    if (b.roof) {
      const pad = b.roof.overhang
      const r = { x: b.x - pad, z: b.z - pad, w: b.w + pad * 2, d: b.d + pad * 2 }
      grid.roofs.push(
        surface(
          r,
          b.height,
          b.height + b.roof.rise,
          'roof',
          (x, z) => roofHeightAt(b, x, z),
          roofSlopeAt(b),
        ),
      )
    }
  }
  // The four porch catwalks sit a couple of centimetres above the porch roof.
  for (const w of layout.catwalks ?? []) {
    grid.overheads.push(surface(w, w.height - 0.02, w.height, 'overhead'))
  }
  for (const c of layout.cover) {
    const top = c.top ?? c.vaultHeight ?? (c.low ? 1 : 3)
    if ((c.y0 ?? 0) > 0.01) {
      // Upper-floor furniture: a solid span above the ground floor, not a base solid.
      grid.overheads.push(surface(c, c.y0 ?? 0, top, 'solid'))
      continue
    }
    if (c.vaultHeight === undefined) {
      fill(grid, c, c.low ? BLOCK_MOVE | BLOCK_SHOT : WALL)
    }
    const shape = shapedCover(c)
    if (shape) {
      grid.shaped.push(shape)
      const c0 = Math.max(0, Math.floor(c.x / grid.cell))
      const c1 = Math.min(grid.n - 1, Math.ceil((c.x + c.w) / grid.cell) - 1)
      const r0 = Math.max(0, Math.floor(c.z / grid.cell))
      const r1 = Math.min(grid.n - 1, Math.ceil((c.z + c.d) / grid.cell) - 1)
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const i = row * grid.n + col
          grid.shapeCells[i] = [...(grid.shapeCells[i] ?? []), shape]
        }
      }
    } else {
      fillTop(grid, c, top)
    }
    if (c.standable) {
      fillStandable(grid, c)
    }
  }
  // Vaultable cover last, so a cell it shares with anything solid stays solid.
  const solid = grid.cells.slice()
  for (const c of layout.cover) {
    if (c.vaultHeight !== undefined && (c.y0 ?? 0) <= 0.01) {
      fill(grid, c, BLOCK_MOVE | BLOCK_SHOT | BLOCK_VAULT)
    }
  }
  for (const [i, before] of solid.entries()) {
    if (before & BLOCK_MOVE) {
      grid.cells[i] = (grid.cells[i] ?? 0) & ~BLOCK_VAULT
    }
  }
  for (const { b, w, index } of townWindows(layout)) {
    grid.glass.push({ index, ...windowPane(b, w) })
  }
  indexWindowHoles(grid, layout)
  return grid
}

/**
 * Bucket every hollow window opening by grid cell, so a 3D ray finds the hole it is passing
 * through with one lookup. Openings only affect ray tests: the wall cells stay solid for movement.
 */
function indexWindowHoles(grid: Grid, layout: TownLayout): void {
  const holes: WindowHole[] = []
  for (const b of layout.buildings) {
    if (!b.hollow) {
      continue
    }
    for (const w of b.windows ?? []) {
      holes.push({
        ...sideWallRect(b, w.side, w.at, w.at + w.width),
        y0: w.sill,
        y1: w.top,
      })
    }
  }
  grid.windowHoles = holes
  const n = grid.n
  const starts = new Int32Array(n * n + 1)
  const bounds = (h: WindowHole): [number, number, number, number] => [
    Math.max(0, Math.floor((h.x + EPS) / grid.cell)),
    Math.min(n - 1, Math.ceil((h.x + h.w - EPS) / grid.cell) - 1),
    Math.max(0, Math.floor((h.z + EPS) / grid.cell)),
    Math.min(n - 1, Math.ceil((h.z + h.d - EPS) / grid.cell) - 1),
  ]
  for (const h of holes) {
    const [c0, c1, r0, r1] = bounds(h)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const ci = row * n + col + 1
        starts[ci] = (starts[ci] ?? 0) + 1
      }
    }
  }
  for (let i = 1; i < starts.length; i++) {
    starts[i] = (starts[i] ?? 0) + (starts[i - 1] ?? 0)
  }
  const refs = new Int32Array(starts[n * n] ?? 0)
  const cursor = starts.slice(0, n * n)
  for (const [k, h] of holes.entries()) {
    const [c0, c1, r0, r1] = bounds(h)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const slot = row * n + col
        refs[cursor[slot] ?? 0] = k
        cursor[slot] = (cursor[slot] ?? 0) + 1
      }
    }
  }
  grid.holeStarts = starts
  grid.holeRefs = refs
}

export function cellAt(grid: Grid, x: number, z: number): number {
  const col = Math.floor(x / grid.cell)
  const row = Math.floor(z / grid.cell)
  if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) {
    return WALL
  }
  return grid.cells[row * grid.n + col] ?? WALL
}

/** A point on the ground plane. */
export interface Point {
  x: number
  z: number
}

/** A circle on the ground plane (a player's capsule seen from above). */
export interface Circle extends Point {
  r: number
}

/** A ray from (`ox`, `oz`) along the unit direction (`dx`, `dz`), walked up to `maxDist`. */
export interface Ray {
  ox: number
  oz: number
  dx: number
  dz: number
  maxDist: number
}

/** One square cell box: its min corner (`x0`, `z0`) and side length. */
interface CellBox {
  x0: number
  z0: number
  size: number
}

export const inRect = (r: Rect, x: number, z: number): boolean =>
  x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d

/** True if a circle at (x, z) overlaps any cell with `mask`. */
/** Whether a circle overlaps a cell with any `mask` bit (cells with any `except` bit don't count). */
export function circleBlocked(grid: Grid, { x, z, r }: Circle, mask: number, except = 0): boolean {
  const c = grid.cell
  const c0 = Math.floor((x - r) / c)
  const c1 = Math.floor((x + r) / c)
  const r0 = Math.floor((z - r) / c)
  const r1 = Math.floor((z + r) / c)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = cellAt(grid, (col + 0.5) * c, (row + 0.5) * c)
      if ((cell & mask) === 0 || (cell & except) !== 0) {
        continue
      }
      const nx = Math.max(col * c, Math.min(x, (col + 1) * c))
      const nz = Math.max(row * c, Math.min(z, (row + 1) * c))
      if ((x - nx) ** 2 + (z - nz) ** 2 < r * r) {
        return true
      }
    }
  }
  return false
}

/** Push point `p` (a circle of radius `r`) out of one cell box. Returns true if it moved. */
function resolveCell(p: Point, { x0: bx0, z0: bz0, size: c }: CellBox, r: number): boolean {
  const nx = Math.max(bx0, Math.min(p.x, bx0 + c))
  const nz = Math.max(bz0, Math.min(p.z, bz0 + c))
  const dx = p.x - nx
  const dz = p.z - nz
  const d2 = dx * dx + dz * dz
  if (d2 >= r * r) {
    return false
  }
  if (d2 > EPS * EPS) {
    const d = Math.sqrt(d2)
    p.x = nx + (dx / d) * r
    p.z = nz + (dz / d) * r
    return true
  }
  // Centre inside the cell: leave along the shallowest axis.
  const left = p.x - bx0
  const right = bx0 + c - p.x
  const up = p.z - bz0
  const down = bz0 + c - p.z
  const m = Math.min(left, right, up, down)
  if (m === left) {
    p.x = bx0 - r
  } else if (m === right) {
    p.x = bx0 + c + r
  } else if (m === up) {
    p.z = bz0 - r
  } else {
    p.z = bz0 + c + r
  }
  return true
}

/**
 * Push a circle out of every blocked cell it overlaps. Deterministic (fixed cell order, up to three
 * passes). Returns the resolved position.
 */
export function pushOut(grid: Grid, { x: px, z: pz, r }: Circle, mask: number, except = 0): Point {
  const p = { x: px, z: pz }
  const c = grid.cell
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    const c0 = Math.floor((p.x - r) / c)
    const c1 = Math.floor((p.x + r) / c)
    const r0 = Math.floor((p.z - r) / c)
    const r1 = Math.floor((p.z + r) / c)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cell = cellAt(grid, (col + 0.5) * c, (row + 0.5) * c)
        const blocked = (cell & mask) !== 0 && (cell & except) === 0
        if (blocked && resolveCell(p, { x0: col * c, z0: row * c, size: c }, r)) {
          moved = true
        }
      }
    }
    if (!moved) {
      break
    }
  }
  return p
}

/**
 * Walk a ray through the grid (Amanatides–Woo DDA). Returns the distance to the first cell with
 * `mask`, or `maxDist` if none.
 */
export function rayGrid(grid: Grid, { ox, oz, dx, dz, maxDist }: Ray, mask: number): number {
  const c = grid.cell
  let col = Math.floor(ox / c)
  let row = Math.floor(oz / c)
  const stepX = dx > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(c / dx)
  const tDeltaZ = dz === 0 ? Number.POSITIVE_INFINITY : Math.abs(c / dz)
  let tMaxX =
    dx === 0 ? Number.POSITIVE_INFINITY : ((stepX > 0 ? (col + 1) * c : col * c) - ox) / dx
  let tMaxZ =
    dz === 0 ? Number.POSITIVE_INFINITY : ((stepZ > 0 ? (row + 1) * c : row * c) - oz) / dz
  let t = 0
  while (t <= maxDist) {
    if ((cellAt(grid, (col + 0.5) * c, (row + 0.5) * c) & mask) !== 0) {
      return t
    }
    if (tMaxX < tMaxZ) {
      t = tMaxX
      tMaxX += tDeltaX
      col += stepX
    } else {
      t = tMaxZ
      tMaxZ += tDeltaZ
      row += stepZ
    }
  }
  return maxDist
}

/** Line of sight between two points (only sight-blocking cells count). */
export function hasLineOfSight(
  grid: Grid,
  { x: ax, z: az }: Point,
  { x: bx, z: bz }: Point,
): boolean {
  const dx = bx - ax
  const dz = bz - az
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d < EPS) {
    return true
  }
  return rayGrid(grid, { ox: ax, oz: az, dx: dx / d, dz: dz / d, maxDist: d }, BLOCK_SIGHT) >= d
}

export function zoneAt(layout: TownLayout, x: number, z: number): Zone | null {
  for (const zone of layout.zones) {
    if ((x - zone.x) ** 2 + (z - zone.z) ** 2 <= zone.r * zone.r) {
      return zone
    }
  }
  return null
}

/** Spawns this close to the map's edge face straight in from it. */
const EDGE_SPAWN = 16

/**
 * Which way a rider faces on spawning there (radians, 0 = +x, toward +z): into town. Perimeter
 * spawns look in from their edge, leaning toward the crossroads; interior ones look at it.
 */
export function spawnFacing(p: Point, layout: TownLayout = TOWN): number {
  const main = layout.streets[0]
  const cx = main ? main.x + main.w / 2 : layout.size / 2
  const cz = main ? main.z + main.d / 2 : layout.size / 2
  let dx = cx - p.x
  let dz = cz - p.z
  const len = Math.hypot(dx, dz) || 1
  dx /= len
  dz /= len
  const s = layout.size
  const edges: [number, number, number][] = [
    [p.x, 1, 0],
    [s - p.x, -1, 0],
    [p.z - layout.creek.z, 0, 1],
    [s - p.z, 0, -1],
  ]
  const [d, nx, nz] = edges.reduce((a, e) => (e[0] < a[0] ? e : a))
  if (d < EDGE_SPAWN) {
    dx += nx * 2
    dz += nz * 2
  }
  return Math.atan2(dz, dx)
}
