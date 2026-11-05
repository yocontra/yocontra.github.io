// biome-ignore-all lint/suspicious/noConsole: a CLI generator reports what it wrote
// biome-ignore-all lint/complexity/useMaxParams: placement helpers take a rect positionally (x, z, w, d), like the layout JSON
// biome-ignore-all lint/style/noMagicNumbers: this file is the town plan: every number is a position in metres
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one town plan, top to bottom
/**
 * The Perdition town plan: writes `ffa/town.layout.json` (the single source of truth for the
 * server's collision grid, the client scene and the minimap). Edit the plan here, regenerate, then
 * run the checks:
 *
 *   bun tools/perdition-layout.ts src/experiments/out-west/ffa/town.layout.json
 *   bun tools/town-audit.ts --png=.playwright-mcp/map-audit-after.png
 *   bun tools/collider-check.ts && bun tools/float-audit.ts --scene=frontier   # dev server up
 *
 * Every cover kind must be one `ffa/scene/cover-kinds.ts` dresses; vault heights come from there.
 * Rects snap to the 0.5 m collision grid.
 */
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { COVER_VISUALS } from '../src/experiments/out-west/ffa/scene/cover-kinds.ts'
import type {
  Building,
  Cover,
  Door,
  Floor,
  Side,
  Stair,
} from '../src/experiments/out-west/ffa/sim/layout.ts'
import { roofSpecFor } from '../src/experiments/out-west/ffa/sim/roofshape.ts'
import { ROOF_WALKS } from '../src/experiments/out-west/ffa/sim/roofwalks.ts'

/** Tall cover: blocks sight as well as movement and bullets. */
const TALL = new Set([
  'shelves',
  'stairs',
  'crate_stack',
  'freight_wagon',
  'covered_wagon',
  'stagecoach',
  'wreck',
  'boxcar',
])

const snap = (v: number) => Math.round(v * 2) / 2
const cover: Cover[] = []
function c(kind: string, x: number, z: number, w: number, d: number): void {
  const vis = COVER_VISUALS[kind]
  if (!vis) {
    throw new Error(`no visual for cover kind ${kind}`)
  }
  const r: Cover = {
    kind,
    x: snap(x),
    z: snap(z),
    w: snap(w),
    d: snap(d),
    low: !TALL.has(kind),
    top: vis.height,
    standable: Math.min(snap(w), snap(d)) >= 0.9,
  }
  if (vis.vault && r.low) {
    r.vaultHeight = vis.height
  }
  cover.push(r)
}
/** Cover on an upper floor: its collision span starts at `y0`, not on the ground. */
function cu(kind: string, x: number, z: number, w: number, d: number, y0: number): void {
  c(kind, x, z, w, d)
  const r = cover.at(-1)
  if (r) {
    r.y0 = y0
    r.top = (r.top ?? 0) + y0
  }
}

/** A fence run along x (dir 'x') or z, with gate gaps [from, to] in absolute coords. */
function fence(
  dir: 'x' | 'z',
  fixed: number,
  a0: number,
  a1: number,
  gaps: [number, number][] = [],
): void {
  let start = a0
  const cuts = [...gaps].sort((p, q) => p[0] - q[0])
  for (const [g0, g1] of [...cuts, [a1, a1] as [number, number]]) {
    if (g0 - start >= 1) {
      if (dir === 'x') {
        c('fence', start, fixed, g0 - start, 0.5)
      } else {
        c('fence', fixed, start, 0.5, g0 - start)
      }
    }
    start = g1
  }
}

const buildings: Building[] = []
function b(
  id: string,
  kind: string,
  x: number,
  z: number,
  w: number,
  d: number,
  height: number,
  floors: number,
  hollow: boolean,
  doors: Door[] = [],
  extra: Partial<Building> = {},
): Building {
  const bd: Building = { id, kind, x, z, w, d, height, floors, hollow, doors, ...extra }
  buildings.push(bd)
  return bd
}
const D = (side: Side, at: number, width: number): Door => ({ side, at, width })

// ---------------------------------------------------------------- buildings
// North row (fronts on main street, porches z 54-56)
const livery = b('livery', 'stable', 24, 34, 16, 20, 5.5, 1, true, [D('s', 5, 6), D('w', 8, 3)])
const saloon = b(
  'saloon',
  'saloon',
  47,
  34,
  19,
  20,
  7.5,
  2,
  true,
  [D('s', 7, 4), D('e', 4, 2), D('n', 13, 2.5)],
  {
    walls: [
      { x: 47, z: 42, w: 12, d: 0.5 },
      { x: 61, z: 42, w: 5, d: 0.5 },
    ],
  },
)
const hotel = b('hotel', 'hotel', 78, 38, 16, 16, 7.5, 2, true, [D('s', 6, 3), D('w', 4, 2)])
const assay = b('assay', 'assay', 97, 42, 10, 12, 4.5, 1, true, [D('s', 3.5, 3)])
const church = b('church', 'church', 110, 30, 14, 22, 8, 1, true, [D('s', 5, 4), D('n', 6, 2)])
b('church_tower', 'tower', 124, 30, 6, 6, 14, 3, false)
// North back lots
b('outhouse_saloon', 'outhouse', 49, 17, 3, 3, 3, 1, false, [], { front: 's' })
b('icehouse', 'shed', 86, 16, 8, 8, 4.5, 1, false, [], { front: 's' })
// South row (fronts on main street, porches z 72-74)
const stage = b('stage_line', 'stage_line', 6, 74, 14, 14, 4.5, 1, true, [
  D('n', 5, 3),
  D('s', 6, 2),
])
const smithy = b('smithy', 'smithy', 24, 74, 12, 12, 5, 1, true, [D('n', 2, 8)])
const store = b('general_store', 'general_store', 40, 74, 18, 16, 4.5, 1, true, [
  D('n', 7, 4),
  D('s', 8, 2),
])
const bank = b(
  'bank',
  'bank',
  62,
  74,
  20,
  18,
  7.5,
  2,
  true,
  [D('n', 8, 4), D('e', 4, 2), D('s', 8, 4), D('w', 4, 2)],
  {
    walls: [
      // The teller partition stops either side of the stairwell, so the stair has a clear entry.
      { x: 62, z: 83, w: 1, d: 0.5 },
      { x: 67, z: 83, w: 4, d: 0.5 },
      { x: 73, z: 83, w: 9, d: 0.5 },
    ],
  },
)
const undertaker = b('undertaker', 'undertaker', 85, 74, 14, 14, 4.5, 1, true, [D('n', 5, 3)])
const jail = b('jail', 'jail', 104, 74, 16, 14, 4.5, 1, true, [D('n', 6, 3), D('s', 6, 3)], {
  walls: [{ x: 104, z: 83, w: 9, d: 0.5 }],
})
// South back lots
b('hay_barn', 'barn', 8, 98, 14, 10, 6, 1, true, [D('e', 4, 4), D('n', 5, 3)], { front: 'e' })
b('outhouse_store', 'outhouse', 54, 100, 3, 3, 3, 1, false, [], { front: 'n' })
b('carriage_shed', 'shed', 124, 96, 12, 9, 4.5, 1, true, [D('w', 3, 3)], { front: 'w' })
b('water_tower', 'water_tower', 118, 113, 4, 4, 12, 1, false)
b('depot', 'depot', 16, 109, 24, 10, 5, 1, true, [D('s', 10, 4), D('n', 10, 3)], {
  front: 's',
})
b('tool_shed', 'shed', 44, 131, 8, 7, 4, 1, false, [], { front: 'n' })
b('stock_shed', 'shed', 118, 131, 8, 8, 4.5, 1, false, [], { front: 'n' })

// every frontage faces main street, whatever street is nearer its middle
for (const bd of [livery, saloon, hotel, assay, church]) {
  bd.front = 's'
}
for (const bd of [stage, smithy, store, bank, undertaker, jail]) {
  bd.front = 'n'
}

// The roof shape is part of the layout now: the sim walks on it and the scene builds it.
const FALSE_FRONT = new Set([
  'saloon',
  'hotel',
  'assay',
  'stage_line',
  'general_store',
  'bank',
  'undertaker',
  'jail',
])
for (const bd of buildings) {
  const front = bd.front ?? 's'
  const span = front === 'n' || front === 's' ? bd.w : bd.d
  const falseFront = FALSE_FRONT.has(bd.kind)
  const bays = falseFront && span > 13 ? 2 : 1
  bd.roof = roofSpecFor(bd, falseFront, front, span, bays)
}

/** A floor rect with a stairwell hole cut out of it. */
function floorAround(bd: Building, hole: { x: number; z: number; w: number; d: number }): Floor[] {
  const x0 = bd.x + 0.5
  const z0 = bd.z + 0.5
  const x1 = bd.x + bd.w - 0.5
  const z1 = bd.z + bd.d - 0.5
  const hx0 = Math.max(x0, hole.x)
  const hz0 = Math.max(z0, hole.z)
  const hx1 = Math.min(x1, hole.x + hole.w)
  const hz1 = Math.min(z1, hole.z + hole.d)
  const y = 3.3
  const out: Floor[] = []
  const add = (x: number, z: number, w: number, d: number) => {
    if (w > 0.1 && d > 0.1) {
      out.push({ x: snap(x), z: snap(z), w: snap(w), d: snap(d), y })
    }
  }
  add(x0, z0, x1 - x0, hz0 - z0)
  add(x0, hz1, x1 - x0, z1 - hz1)
  add(x0, hz0, hx0 - x0, hz1 - hz0)
  add(hx1, hz0, x1 - hx1, hz1 - hz0)
  return out
}

// Real second floors for the three two-storey walk-ins.
const upper: [Building, Stair][] = [
  [saloon, { x: 60.5, z: 45, w: 3, d: 6, fromY: 0, toY: 3.3, dir: 'n' }],
  [hotel, { x: 79.5, z: 45, w: 3, d: 6, fromY: 0, toY: 3.3, dir: 'n' }],
  [bank, { x: 63.5, z: 83, w: 3, d: 6, fromY: 0, toY: 3.3, dir: 'n' }],
]
// Upper-floor furniture (collision spans start at the 3.3 m floor).
cu('bed', 48, 40, 2, 2, 3.3)
cu('table', 52, 40, 1.5, 1.5, 3.3)
cu('crates', 64, 36, 1.5, 1.5, 3.3)
cu('bed', 84, 40, 2, 2, 3.3)
cu('bed', 88, 40, 2, 2, 3.3)
cu('bed', 84, 49, 2, 2, 3.3)
cu('counter', 68, 76, 3, 1, 3.3)
cu('safe', 79, 76, 1.5, 1.5, 3.3)
cu('crates', 67, 89, 1.5, 1.5, 3.3)

// Ground-floor details the walk-in shells were missing (solid sheds keep their props outside).
c('workbench', 27, 46, 2, 1)
c('crates', 36, 40, 1.5, 1.5)

for (const [bd, stair] of upper) {
  bd.stairs = [stair]
  bd.upperFloor = floorAround(bd, stair)
  const wallY = { y0: 3.3, y1: bd.height }
  if (bd.id === 'saloon') {
    bd.walls = [
      ...(bd.walls ?? []),
      { x: 55, z: 47, w: 0.5, d: 6, ...wallY },
      { x: 55, z: 47, w: 6, d: 0.5, ...wallY },
    ]
  } else if (bd.id === 'hotel') {
    bd.walls = [
      ...(bd.walls ?? []),
      { x: 86, z: 39, w: 0.5, d: 13, ...wallY },
      { x: 86, z: 46, w: 7, d: 0.5, ...wallY },
    ]
  } else {
    bd.walls = [
      ...(bd.walls ?? []),
      { x: 72, z: 75, w: 0.5, d: 7, ...wallY },
      { x: 72, z: 81.5, w: 9, d: 0.5, ...wallY },
    ]
  }
}

// ---------------------------------------------------------------- porches: posts (colliders)
const PORCHED = new Set([
  'saloon',
  'hotel',
  'general_store',
  'stage_line',
  'assay',
  'undertaker',
  'jail',
  'bank',
  'smithy',
])
function porchPosts(bd: Building, side: Side): void {
  const len = side === 'n' || side === 's' ? bd.w : bd.d
  const n = Math.max(2, Math.round(len / 4.5))
  for (let i = 0; i <= n; i++) {
    // posts at the porch's outer edge, cell aligned, never in front of a door
    let a = snap(0.25 + ((len - 0.5) * i) / n - 0.25)
    a = Math.min(len - 0.5, Math.max(0, a))
    const doorHit = bd.doors.some(
      (d) => d.side === side && a + 0.5 > d.at - 0.3 && a < d.at + d.width + 0.3,
    )
    if (doorHit) {
      continue
    }
    if (side === 's') {
      c('post', bd.x + a, bd.z + bd.d + 1.5, 0.5, 0.5)
    } else {
      c('post', bd.x + a, bd.z - 2, 0.5, 0.5)
    }
  }
}
for (const bd of [livery, saloon, hotel, assay]) {
  if (PORCHED.has(bd.kind)) {
    porchPosts(bd, 's')
  }
}
for (const bd of [stage, smithy, store, bank, undertaker, jail]) {
  if (PORCHED.has(bd.kind)) {
    porchPosts(bd, 'n')
  }
}

// ---------------------------------------------------------------- main street (z 56-72)
// a trough out in the open first (the layout test shoots past the first trough it finds)
c('trough', 12, 70, 2.5, 1)
// Sight breakers: five bands across the street, tall pieces in each no more than ~45 m apart,
// staggered band to band so the street reads as parked traffic, never a wall.
// B1 z 57-59
c('crate_stack', 22, 57.5, 1.5, 1.5)
c('covered_wagon', 55, 57, 5, 2)
c('crate_stack', 100, 57.5, 1.5, 1.5)
// B2 z 60-62
c('stagecoach', 30, 60, 5, 2)
c('covered_wagon', 80, 60, 5, 2)
c('stagecoach', 118, 60, 5, 2)
// B3 z 63-65
c('covered_wagon', 51, 63, 5, 2)
c('freight_wagon', 92, 63, 5, 2)
c('wreck', 128, 62.5, 5, 3)
// B4 z 66-68
c('stagecoach', 12, 66, 5, 2)
c('covered_wagon', 60, 66, 5, 2)
c('freight_wagon', 104, 66, 5, 2)
// B5 z 69.5-71
c('crate_stack', 34, 69.5, 1.5, 1.5)
c('crate_stack', 84, 69.5, 1.5, 1.5)
c('crate_stack', 120, 69.5, 1.5, 1.5)
// the town well at the crossroads
c('well', 71, 63, 2, 2)
// hitching rails off the boardwalks, troughs at their ends
c('hitch_rail', 26, 57.5, 4, 0.5)
c('hitch_rail', 47.5, 57.5, 4, 0.5)
c('trough', 51.5, 57.5, 2.5, 1)
c('hitch_rail', 79, 57.5, 4, 0.5)
c('trough', 83, 57.5, 2.5, 1)
c('hitch_rail', 89, 57.5, 4, 0.5)
c('hitch_rail', 103, 57.5, 3.5, 0.5)
c('trough', 112, 57.5, 2.5, 1)
c('hitch_rail', 8, 70.5, 4, 0.5)
c('hitch_rail', 42, 70.5, 4, 0.5)
c('trough', 46, 70, 2.5, 1)
c('hitch_rail', 52, 70.5, 4, 0.5)
c('hitch_rail', 88, 70.5, 4, 0.5)
c('trough', 92, 70, 2.5, 1)
c('hitch_rail', 106, 70.5, 4, 0.5)
c('hitch_rail', 113, 70.5, 4, 0.5)
// odds and ends between
c('barrels', 4.5, 60, 1.5, 1.5)
c('crates', 65.5, 70, 1.5, 1)
c('barrels', 136, 66, 1.5, 1.5)
c('crates', 133, 58, 1.5, 1.5)
c('barrels', 67, 57.5, 1, 1)
c('barrels', 76.5, 57.5, 1, 1)

// ---------------------------------------------------------------- north back lots (z 12-34)
// corral west of the livery, gates on each side
fence('x', 6, 18, 22, [[12, 15]])
fence('x', 48, 6, 22, [[8, 11]])
fence('z', 6, 18.5, 48, [[30, 33]])
fence('z', 21.5, 18.5, 48, [
  [24, 27],
  [41, 46],
])
c('hay', 8, 20, 2, 1)
c('hay', 8, 21, 2, 1)
c('hay', 17, 36, 2, 1)
c('trough', 12, 44, 2.5, 1)
// livery back: lumber and a wagon
c('lumber', 26, 27, 4, 1.5)
c('wagon', 34, 25, 2, 4)
// saloon back yard: woodpile, barrels, crates by the back door
c('woodpile', 55, 28, 3, 1)
c('barrels', 63, 30, 1.5, 1.5)
c('crates', 57, 20, 1.5, 1.5)
c('crate_stack', 41.5, 31, 1.5, 1.5)
// north road: a covered wagon pulled over, crates
c('covered_wagon', 68.5, 28, 2, 5)
c('crates', 74, 40, 1.5, 1.5)
c('barrels', 74.5, 18, 1, 1.5)
// behind the hotel: icehouse yard
c('lumber', 80, 26, 4, 1.5)
c('woodpile', 96, 24, 1, 3)
c('wagon', 98, 32, 4, 2)
c('crates', 82, 33, 1.5, 1.5)
// cemetery north of the church, picket fence, headstones
fence('x', 15, 108, 136, [[114, 117]])
fence('z', 108, 15.5, 28)
fence('z', 135.5, 15.5, 28)
for (const [x, z] of [
  [111, 18],
  [114, 18],
  [119, 18],
  [122, 18],
  [126, 18],
  [129, 18],
  [132, 18],
  [111, 23],
  [119, 23],
  [122, 23],
  [127, 23],
  [131, 23],
] as const) {
  c('headstone', x, z, 0.5, 0.5)
}
c('crates', 103, 36, 1.5, 1.5)
c('barrels', 132, 40, 1.5, 1.5)
c('lumber', 128, 47, 1.5, 4)

// ---------------------------------------------------------------- creek bank: rail fence with gaps
// (a way down every ~12 m: a long unbroken fence pinned riders in fights across it)
fence('x', 12, 9, 68, [
  [20, 23],
  [32, 35],
  [44, 47],
  [56, 59],
])
c('bridge_rail', 68, 3.5, 0.5, 8.5)
c('bridge_rail', 75.5, 3.5, 0.5, 8.5)
fence('x', 12, 76, 135, [
  [86, 89],
  [98, 101],
  [110, 113],
  [122, 125],
])

// ---------------------------------------------------------------- interiors
// Every walk-in building furnished as the room it is, against its walls, doorways and spawn
// points kept clear. All of it is cover like anything else (what blocks you is what you see).
// saloon: back bar and bar along the west wall, tables, a piano; the storeroom behind
c('shelves', 47.5, 44, 0.5, 7)
c('counter', 49, 44, 0.5, 6.5)
c('table', 51.5, 47, 1.5, 1.5)
c('table', 55.5, 45.5, 1.5, 1.5)
c('table', 55, 50, 1.5, 1.5)
c('table', 52, 51, 1.5, 1.5)
c('piano', 64.5, 47, 1, 1.5)
c('stove', 64.5, 51.5, 1, 1)
c('barrels', 47.5, 34.5, 1.5, 1.5)
c('barrel_rack', 50.5, 34.5, 2, 1)
c('crates', 53.5, 34.5, 1.5, 1.5)
c('crate_stack', 64, 34.5, 1.5, 1.5)
// hotel lobby: desk and key rack, stairs up, a bench and a table by the stove
c('shelves', 78.5, 45, 0.5, 4)
c('counter', 84, 44, 4, 0.5)
c('bench', 93, 48, 0.5, 2)
c('table', 88.5, 49.5, 1.5, 1.5)
c('stove', 92, 51.5, 1, 1)
// assay office: counter, safe, shelves of samples, stove
c('counter', 99, 45, 3, 0.5)
c('safe', 104, 42.5, 1.5, 1)
c('shelves', 97.5, 47, 0.5, 4)
c('stove', 105.5, 49, 1, 1)
// church: pews either side of the aisle, the altar and the pulpit
for (const z of [35.5, 38.5, 41.5, 46.5, 49.5]) {
  c('bench', 110.5, z, 4, 0.5)
  c('bench', 119.5, z, 4, 0.5)
}
c('counter', 111.5, 31.5, 3, 1)
c('counter', 120, 31.5, 1, 1)
// stage line: ticket counter (the deposit spot is in front of it), mail shelves, luggage, bench
c('counter', 11.5, 82, 3, 0.5)
c('shelves', 6.5, 78, 0.5, 3)
c('crates', 6.5, 86, 1.5, 1.5)
c('bench', 15.5, 74.5, 2.5, 0.5)
c('stove', 17.5, 80, 1, 1)
// smithy: forge, anvil, workbench, the quenching barrel
c('forge', 24.5, 83, 2.5, 2.5)
c('anvil', 29.5, 80, 1, 0.5)
c('workbench', 33, 84.5, 2.5, 1)
c('barrels', 30.5, 84.5, 1, 1)
// general store: counter, shelves down both walls, barrels and crates of stock, stove
c('counter', 43, 79, 6, 0.5)
c('shelves', 40.5, 80, 0.5, 8)
c('shelves', 57, 78, 0.5, 6)
c('crates', 54, 74.5, 1.5, 1.5)
c('barrels', 43.5, 86, 1.5, 1.5)
c('barrel_rack', 54, 87.5, 2, 1)
c('stove', 46.5, 83.5, 1, 1)
// bank: benches in the lobby; safes and a clerk's desk in the vault room behind the partition
c('bench', 63.5, 74.5, 3, 0.5)
c('bench', 77.5, 74.5, 3, 0.5)
c('safe', 68, 90, 1.5, 1.5)
c('safe', 80, 90, 1.5, 1.5)
c('counter', 67, 86, 2, 1)
c('crates', 77, 85, 1.5, 1.5)
// undertaker: coffins, workbench, lumber for the next ones
c('coffins', 95, 76, 2.5, 1)
c('coffins', 87, 85, 1, 2.5)
c('workbench', 91.5, 86.5, 3, 1)
c('lumber', 97, 80, 1.5, 3)
// sheriff and jail: desk, gun rack, stove; a cell with its door open and a cot inside
c('counter', 106, 77, 2, 1)
c('shelves', 104.5, 80, 0.5, 3)
c('stove', 117.5, 75.5, 1, 1)
c('bench', 115, 82.5, 3, 0.5)
c('bars', 104.5, 85, 2.5, 0.5)
c('bars', 108.5, 85, 1.5, 0.5)
c('bed', 104.5, 86.5, 2, 1)
// livery: stalls down the east wall, hay, a trough
for (const z of [38, 42, 46, 50]) {
  c('fence', 35.5, z, 4, 0.5)
}
c('hay', 26, 36, 2, 1)
c('trough', 24.5, 49, 2.5, 1)
// depot: waiting bench, ticket counter, baggage shelves, trunks, stove
c('bench', 20, 113, 4, 0.5)
c('counter', 31, 111, 4, 0.5)
c('shelves', 39, 109.5, 0.5, 3)
c('crates', 16.5, 109.5, 1.5, 1.5)
c('stove', 36, 117.5, 1, 1)
// hay barn: bales stacked along the west wall
c('hay', 8.5, 98.5, 2, 1)
c('hay', 8.5, 99.5, 2, 1)
c('hay', 8.5, 104, 2, 1)
c('hay', 8.5, 105, 2, 1)
// carriage shed: a coach in for repair, a workbench
c('stagecoach', 129, 98.5, 5, 2)
c('workbench', 132, 103.5, 2.5, 1)

// ---------------------------------------------------------------- south back lots (z 92-122)
c('hay', 24, 100, 2, 1)
c('hay', 24, 101, 2, 1)
c('wagon', 26, 105, 4, 2)
c('lumber', 34, 94, 4, 1.5)
c('woodpile', 30, 89.5, 3, 1)
c('crates', 46, 96, 1.5, 1.5)
c('barrels', 60, 96, 1.5, 1.5)
c('crates', 62, 104, 1.5, 1.5)
c('covered_wagon', 75, 103, 2, 5) // cross street
c('barrels', 67, 112, 1.5, 1.5)
c('crates', 76.5, 117, 1.5, 1.5)
c('coffins', 92, 92, 2.5, 1) // undertaker yard
c('lumber', 86, 100, 4, 1.5)
c('wagon', 96, 108, 4, 2)
fence('x', 102, 102, 122, [[109, 113]]) // jail yard
fence('z', 121.5, 88.5, 102)
c('crate_stack', 106, 96, 1.5, 1.5)
c('barrels', 114, 108, 1.5, 1.5)
c('woodpile', 130, 108, 3, 1)
c('crates', 136, 92, 1.5, 1.5)
c('well', 40, 102, 2, 2)
// east end lot (behind the jail, by the carriage shed)
c('hay', 128, 80, 2, 1)
c('hay', 128, 81, 2, 1)
c('wagon', 134, 84, 2, 4)
c('lumber', 124, 90, 4, 1.5)
// between the depot and the cross street
c('woodpile', 50, 112, 3, 1)
c('crates', 58, 117, 1.5, 1.5)
// rail yard east of the crossing
c('crates', 86, 118, 1.5, 1.5)
c('barrels', 94, 116, 1.5, 1.5)
c('lumber', 88, 121, 4, 1.5)
// the crossing south of the track
c('wagon', 66.5, 130, 2, 4)
c('barrels', 76.5, 134, 1.5, 1.5)

// ---------------------------------------------------------------- railroad (track z 125)
c('buffer', 8, 124, 1, 2)
c('buffer', 135, 124, 1, 2)
c('boxcar', 46, 123.5, 12, 3)
c('boxcar', 100, 123.5, 12, 3)
// the telegraph: poles along the track, then up the cross street to the bank (wires join each
// pole to the next one listed, so keep them in line order)
for (const x of [12, 36, 60, 84, 108, 132].toReversed()) {
  c('pole', x, 128, 0.5, 0.5)
}
c('pole', 79, 112, 0.5, 0.5)
c('pole', 79, 96, 0.5, 0.5)
// porch benches against the walls, either side of the doors
c('bench', 49.5, 54, 2, 0.5)
c('bench', 78.5, 54, 2, 0.5)
c('bench', 97.5, 54, 1.5, 0.5)
c('bench', 41, 73.5, 2, 0.5)
c('bench', 87, 73.5, 2, 0.5)
// depot platform clutter (platform z 119-123.5, x 14-42)
c('crates', 18, 120.5, 1.5, 1.5)
c('barrels', 37, 120.5, 1.5, 1.5)
c('bench', 23, 120.5, 2.5, 0.5)
// south of the track: stock pens and a loading chute
fence('x', 130, 84, 110, [[94, 98]])
fence('z', 84, 130.5, 140)
fence('z', 109.5, 130.5, 140, [[134, 137]])
fence('z', 96.5, 133, 140)
c('trough', 88, 136, 2.5, 1)
c('hay', 102, 136, 2, 1)
c('crates', 62, 132, 1.5, 1.5)
c('lumber', 30, 133, 4, 1.5)
c('barrels', 12, 134, 1.5, 1.5)
c('wagon', 132, 133, 2, 4)

// ---------------------------------------------------------------- spawns (32), zones, spots
const spawns = [
  // creek bed
  [16, 7.5],
  [44, 7.5],
  [100, 7.5],
  [140, 128],
  // west edge
  [2.5, 52],
  [2.5, 94],
  [2.5, 117],
  [3, 139],
  // east edge
  [141.5, 30],
  [141.5, 52],
  [141.5, 80],
  [141.5, 110],
  // south edge
  [40, 139.5],
  [58, 140],
  [80, 140],
  [102, 140],
  [128, 140],
  // back lots
  [14, 26],
  [42, 20],
  [84, 21],
  [102, 18],
  [140, 20],
  [88, 116],
  [44, 116],
].map(([x, z]) => ({ x, z, interior: false }))
for (const [x, z] of [
  [32, 44],
  [57, 37],
  [88, 42],
  [117, 44],
  [12, 78],
  [112, 79],
  [30, 113],
  [15, 104],
]) {
  spawns.push({ x: x as number, z: z as number, interior: true })
}

const layout = {
  // biome-ignore lint/style/useNamingConvention: JSON's own comment key
  $comment:
    'Perdition, the Frontier town. Single source of truth for server collision, the client scene and the minimap. Units are metres; x runs east, z runs south, origin at the north-west corner. Rects are {x, z} min corner plus {w, d} size, on the 0.5 m collision grid. Low cover blocks movement and bullets but not sight; vaultHeight (m) marks low cover a rider can vault; top (m) is what a rider can stand on. Buildings carry their roof shape, second floors and stairs. Generated by tools/perdition-layout.ts (edit the plan there); tools/town-audit.ts lists the checks it must pass.',
  version: 3,
  name: 'Perdition',
  size: 144,
  cell: 0.5,
  streets: [
    { id: 'main_street', x: 4, z: 56, w: 136, d: 16 },
    { id: 'north_road', x: 68, z: 12, w: 8, d: 44 },
    { id: 'cross_street', x: 66, z: 92, w: 12, d: 48 },
  ],
  creek: {
    x: 4,
    z: 3,
    w: 136,
    d: 9,
    banks: [],
    bridge: { x: 68, z: 3, w: 8, d: 9.5 },
  },
  buildings,
  cover,
  catwalks: ROOF_WALKS.map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d, height: w.height })),
  zones: [
    { id: 'bank_w1', kind: 'bank', x: 64.5, z: 81.5, r: 1.3 },
    { id: 'bank_w2', kind: 'bank', x: 68.5, z: 81.5, r: 1.3 },
    { id: 'bank_w3', kind: 'bank', x: 75.5, z: 81.5, r: 1.3 },
    { id: 'bank_w4', kind: 'bank', x: 79.5, z: 81.5, r: 1.3 },
    { id: 'stage_counter', kind: 'stage', x: 13, z: 84, r: 1.8 },
  ],
  spawns,
  strongboxes: [
    { id: 'saloon_porch', x: 56, z: 59.5 },
    { id: 'church_yard', x: 117, z: 57.5 },
    { id: 'jail_yard', x: 112, z: 96 },
    { id: 'corral', x: 14, z: 34 },
    { id: 'depot_platform', x: 30, z: 121.5 },
    { id: 'water_tower', x: 115, z: 117 },
    { id: 'creek_bed', x: 58, z: 7.5 },
    { id: 'hay_barn', x: 26, z: 98 },
  ],
  pickups: [
    { id: 'rifle_tower', kind: 'rifle', x: 127, z: 38.5 },
    { id: 'rifle_balcony', kind: 'rifle', x: 56, z: 55 },
    { id: 'shotgun_store', kind: 'shotgun', x: 50, z: 86 },
    { id: 'shotgun_depot', kind: 'shotgun', x: 34, z: 113 },
    { id: 'dynamite_smithy', kind: 'dynamite', x: 31, z: 77 },
    { id: 'dynamite_corral', kind: 'dynamite', x: 10, z: 40 },
  ],
}
writeFileSync(process.argv[2] ?? 'town.layout.json', `${JSON.stringify(layout, null, 2)}\n`)
console.log(`${buildings.length} buildings, ${cover.length} cover, ${spawns.length} spawns`)
