// biome-ignore-all lint/suspicious/noConsole: a CLI audit reports to the terminal
// biome-ignore-all lint/style/noMagicNumbers: tolerances and building rules in metres
/**
 * Per-building audit of Perdition. No browser needed:
 *
 *   bun tools/building-audit.ts [--json]
 *
 * It checks every building's door/window/roof/floor rules against the same constants the scene
 * builder uses (`ffa/scene/building-rules.ts`): frames reach the lintel, windows clear doors,
 * porches and eaves, two-storey walk-ins have real floors and stairs, every building has a roof
 * shape, and closed doors fit their facades. Exit code 1 on errors.
 */
import process from 'node:process'
import {
  doorTop,
  windowSlots as sharedWindowSlots,
  WALL_T,
  type WindowOpening,
} from '../src/experiments/out-west/ffa/scene/building-rules.ts'
import { type Building, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import {
  frontOf,
  PORCH_ROOF,
  PORCH_ROOF_T,
  PORCHED,
} from '../src/experiments/out-west/ffa/sim/porches.ts'

const asJson = process.argv.includes('--json')
type Level = 'error' | 'warn'
interface Issue {
  level: Level
  building: string
  kind: string
  msg: string
}
const issues: Issue[] = []
const flag = (level: Level, building: string, kind: string, msg: string) =>
  issues.push({ level, building, kind, msg })

const sideLength = (b: Building, side: string): number => (side === 'n' || side === 's' ? b.w : b.d)

const overlaps = (
  a: { x: number; z: number; w: number; d: number },
  b: { x: number; z: number; w: number; d: number },
  pad = 0,
): boolean =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.z < b.z + b.d + pad && b.z < a.z + a.d + pad

/** The clear strip just inside a doorway. */
function doorInside(
  b: Building,
  side: string,
  at: number,
  width: number,
): { x: number; z: number; w: number; d: number } {
  const depth = 1.6
  switch (side) {
    case 'n':
      return { x: b.x + at + 0.1, z: b.z + 0.5, w: Math.max(0.2, width - 0.2), d: depth }
    case 's':
      return {
        x: b.x + at + 0.1,
        z: b.z + b.d - 0.5 - depth,
        w: Math.max(0.2, width - 0.2),
        d: depth,
      }
    case 'e':
      return {
        x: b.x + b.w - 0.5 - depth,
        z: b.z + at + 0.1,
        w: depth,
        d: Math.max(0.2, width - 0.2),
      }
    default:
      return { x: b.x + 0.5, z: b.z + at + 0.1, w: depth, d: Math.max(0.2, width - 0.2) }
  }
}

/** The strip at the bottom of a stair, where a rider walks on. */
function stairFoot(st: { x: number; z: number; w: number; d: number; dir: string }): {
  x: number
  z: number
  w: number
  d: number
} {
  switch (st.dir) {
    case 'n':
      return { x: st.x, z: st.z + st.d, w: st.w, d: 1.4 }
    case 's':
      return { x: st.x, z: st.z - 1.4, w: st.w, d: 1.4 }
    case 'e':
      return { x: st.x - 1.4, z: st.z, w: 1.4, d: st.d }
    default:
      return { x: st.x + st.w, z: st.z, w: 1.4, d: st.d }
  }
}

/** The landing at the top of a stair, on the upper floor. */
function stairLanding(st: { x: number; z: number; w: number; d: number; dir: string }): {
  x: number
  z: number
  w: number
  d: number
} {
  switch (st.dir) {
    case 'n':
      return { x: st.x, z: st.z, w: st.w, d: 1.4 }
    case 's':
      return { x: st.x, z: st.z + st.d - 1.4, w: st.w, d: 1.4 }
    case 'e':
      return { x: st.x + st.w - 1.4, z: st.z, w: 1.4, d: st.d }
    default:
      return { x: st.x, z: st.z, w: 1.4, d: st.d }
  }
}

interface Slot {
  side: string
  floor: number
  at: number
  span: number
  bottom: number
  top: number
  shop: boolean
}

/** The shared opening table, in the audit's local shape. */
function windowSlots(b: Building, front: string): Slot[] {
  return sharedWindowSlots(b, front as WindowOpening['side']).map((w) => ({
    side: w.side,
    floor: w.floor,
    at: w.at,
    span: w.width,
    bottom: w.sill,
    top: w.top,
    shop: w.shop,
  }))
}

/** Room reachability audit: raster step, minimum room area (m²), body clearance and upper storey. */
const ROOM_CELL = 0.2
const ROOM_MIN_AREA = 2
const ROOM_CLEARANCE = 0.3
const UPPER_Y = 3.3
/** How far inside an exterior door the reachability seed starts, metres. */
const DOOR_SEED_INSET = 0.6

interface Seed {
  x: number
  z: number
}

/** The stair's top landing (or its foot, for the ground-floor connectivity check). */
function stairPoint(st: NonNullable<Building['stairs']>[number], top: boolean): Seed {
  const x = st.x + st.w / 2
  const z = st.z + st.d / 2
  const out = 0.6
  switch (st.dir) {
    case 'n':
      return top ? { x, z: st.z - out } : { x, z: st.z + st.d - 0.4 }
    case 's':
      return top ? { x, z: st.z + st.d + out } : { x, z: st.z + 0.4 }
    case 'e':
      return top ? { x: st.x + st.w + out, z } : { x: st.x + 0.4, z }
    default:
      return top ? { x: st.x - out, z } : { x: st.x + st.w - 0.4, z }
  }
}

/**
 * Flood each storey's floor and report sealed rooms and walled-off stairs. Walls are the same
 * `b.walls` rects the scene and sim use; the stairwell is a hole in the floor, not a wall, so it
 * connects the strips around it.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one floor raster and two floods are one audit
function auditRooms(b: Building, id: string): void {
  const x0 = b.x + WALL_T + ROOM_CLEARANCE
  const z0 = b.z + WALL_T + ROOM_CLEARANCE
  const x1 = b.x + b.w - WALL_T - ROOM_CLEARANCE
  const z1 = b.z + b.d - WALL_T - ROOM_CLEARANCE
  const cols = Math.max(1, Math.floor((x1 - x0) / ROOM_CELL))
  const rows = Math.max(1, Math.floor((z1 - z0) / ROOM_CELL))
  const n = cols * rows
  const cell = (x: number, z: number): number | null => {
    const c = Math.floor((x - x0) / ROOM_CELL)
    const r = Math.floor((z - z0) / ROOM_CELL)
    return c < 0 || r < 0 || c >= cols || r >= rows ? null : r * cols + c
  }
  for (const floorY of [0, UPPER_Y]) {
    if (floorY > 0 && !(b.upperFloor && b.upperFloor.length > 0)) {
      continue
    }
    const label = floorY > 0 ? 'upper' : 'ground'
    const blocked = new Uint8Array(n)
    for (const w of b.walls ?? []) {
      const y0 = w.y0 ?? 0
      const y1 = w.y1 ?? b.height
      if (y0 > floorY + 0.2 || y1 < floorY + 1) {
        continue
      }
      const c0 = Math.max(0, Math.floor((w.x - ROOM_CLEARANCE - x0) / ROOM_CELL))
      const c1 = Math.min(cols - 1, Math.ceil((w.x + w.w + ROOM_CLEARANCE - x0) / ROOM_CELL) - 1)
      const r0 = Math.max(0, Math.floor((w.z - ROOM_CLEARANCE - z0) / ROOM_CELL))
      const r1 = Math.min(rows - 1, Math.ceil((w.z + w.d + ROOM_CLEARANCE - z0) / ROOM_CELL) - 1)
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const cx = x0 + (c + 0.5) * ROOM_CELL
          const cz = z0 + (r + 0.5) * ROOM_CELL
          if (
            cx >= w.x - ROOM_CLEARANCE &&
            cx <= w.x + w.w + ROOM_CLEARANCE &&
            cz >= w.z - ROOM_CLEARANCE &&
            cz <= w.z + w.d + ROOM_CLEARANCE
          ) {
            blocked[r * cols + c] = 1
          }
        }
      }
    }
    const seeds: Seed[] = []
    if (floorY === 0) {
      for (const d of b.doors) {
        const along = d.side === 'n' || d.side === 's'
        let x = b.x + d.at + d.width / 2
        let z = b.z + d.at + d.width / 2
        if (along) {
          z = d.side === 'n' ? z0 + DOOR_SEED_INSET : z1 - DOOR_SEED_INSET
        } else {
          x = d.side === 'w' ? x0 + DOOR_SEED_INSET : x1 - DOOR_SEED_INSET
        }
        seeds.push({ x, z })
      }
    } else {
      for (const st of b.stairs ?? []) {
        seeds.push(stairPoint(st, true))
      }
    }
    if (seeds.length === 0) {
      flag('error', id, 'room', `${label} floor has no way in`)
      continue
    }
    const seen = new Uint8Array(n)
    const queue: number[] = []
    for (const s of seeds) {
      let cellIndex = cell(s.x, s.z)
      if (cellIndex !== null && blocked[cellIndex] === 1) {
        // A door or stair seed can sit in a jamb: look a little way around it.
        outer: for (let rad = 1; rad <= 5; rad++) {
          for (let dr = -rad; dr <= rad; dr++) {
            for (let dc = -rad; dc <= rad; dc++) {
              const q = cell(s.x + dc * ROOM_CELL, s.z + dr * ROOM_CELL)
              if (q !== null && blocked[q] === 0) {
                cellIndex = q
                break outer
              }
            }
          }
        }
      }
      if (cellIndex === null || blocked[cellIndex] === 1) {
        flag('error', id, 'room', `${label} floor: a door or stair landing is walled off`)
        continue
      }
      if (seen[cellIndex] === 0) {
        seen[cellIndex] = 1
        queue.push(cellIndex)
      }
    }
    for (const i of queue) {
      const c = i % cols
      const r = Math.floor(i / cols)
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) {
          continue
        }
        const q = nr * cols + nc
        if (blocked[q] === 0 && seen[q] === 0) {
          seen[q] = 1
          queue.push(q)
        }
      }
    }
    if (floorY === 0) {
      for (const st of b.stairs ?? []) {
        const p = stairPoint(st, false)
        const i = cell(p.x, p.z)
        if (i !== null && seen[i] === 0) {
          flag('error', id, 'stair', 'stair foot is walled off from the ground floor')
        }
      }
    }
    // Any decent-sized free area the doors/stairs could not reach is a sealed room.
    const open = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (blocked[i] === 0 && seen[i] === 0) {
        open[i] = 1
      }
    }
    for (let i = 0; i < n; i++) {
      if (open[i] === 0) {
        continue
      }
      let area = 0
      const q: number[] = [i]
      open[i] = 0
      for (const j of q) {
        area++
        const c = j % cols
        const r = Math.floor(j / cols)
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nc = c + dc
          const nr = r + dr
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) {
            continue
          }
          const k = nr * cols + nc
          if (open[k] === 1) {
            open[k] = 0
            q.push(k)
          }
        }
      }
      const m2 = area * ROOM_CELL * ROOM_CELL
      if (m2 >= ROOM_MIN_AREA) {
        flag('error', id, 'room', `${label} room of ${m2.toFixed(1)} m² is sealed off`)
      }
    }
  }
}

for (const b of TOWN.buildings) {
  const front = frontOf(b, TOWN)
  const id = b.id
  const slots = windowSlots(b, front)
  const inside = TOWN.cover.filter(
    (c) =>
      c.x >= b.x &&
      c.z >= b.z &&
      c.x + c.w <= b.x + b.w &&
      c.z + c.d <= b.z + b.d &&
      (c.y0 ?? 0) === 0,
  )

  // A decorative `stairs` cover with no real stair behind it is a staircase to nowhere.
  for (const c of inside) {
    if (c.kind === 'stairs') {
      flag('error', id, 'stair', 'decorative staircase to nowhere (use Building.stairs)')
    }
  }

  // Doors: a frame that reaches the wall, a wall above it, and a wide enough opening.
  // Nothing may stand in the strip just inside a doorway.
  for (const d of b.doors) {
    const approach = doorInside(b, d.side, d.at, d.width)
    for (const c of inside) {
      if (overlaps(approach, c)) {
        flag('error', id, 'door', `${d.side} door is blocked inside by ${c.kind}`)
      }
    }
  }

  // Stairs need a clear footprint, a clear foot, and a landing that is not inside an upper wall.
  for (const st of b.stairs ?? []) {
    for (const c of inside) {
      if (overlaps(st, c)) {
        flag('error', id, 'stair', `stair is blocked by ${c.kind}`)
      }
    }
    const foot = stairFoot(st)
    for (const c of inside) {
      if (overlaps(foot, c)) {
        flag('error', id, 'stair', `stair foot is blocked by ${c.kind}`)
      }
    }
    const landing = stairLanding(st)
    for (const w of b.walls ?? []) {
      if ((w.y0 ?? 0) > 0 && overlaps(landing, w)) {
        flag('error', id, 'stair', 'stair lands inside an upper wall')
      }
    }
    for (const c of TOWN.cover.filter((q) => (q.y0 ?? 0) > 0)) {
      if (overlaps(landing, c)) {
        flag('error', id, 'stair', `stair lands inside ${c.kind}`)
      }
    }
  }

  for (const d of b.doors) {
    const top = doorTop(d.width)
    if (top > b.height - 0.6) {
      flag(
        'error',
        id,
        'door',
        `${d.side} door top ${top.toFixed(2)} leaves no wall under ${b.height}`,
      )
    }
    if (d.width < 1.4) {
      flag('warn', id, 'door', `${d.side} door is only ${d.width.toFixed(2)} m wide`)
    }
    if (d.at < 0.2 || d.at + d.width > sideLength(b, d.side) - 0.2) {
      flag('error', id, 'door', `${d.side} door runs outside the wall`)
    }
    if (PORCHED.has(b.kind) && d.side === front && top > PORCH_ROOF - PORCH_ROOF_T / 2 - 0.02) {
      flag('error', id, 'door', `${d.side} door frame clips the porch roof (${top.toFixed(2)} m)`)
    }
  }

  // Windows: inside the wall, clear of doors, porches and the eave.
  for (const s of slots) {
    const len = sideLength(b, s.side)
    if (s.at < 0.4 || s.at + s.span > len - 0.4) {
      flag('error', id, 'window', `${s.side} window runs outside the wall`)
    }
    if (s.top > b.height - 0.15) {
      flag('error', id, 'window', `${s.side} window top ${s.top.toFixed(2)} is above the eave`)
    }
    if (s.bottom < 0.55) {
      flag('warn', id, 'window', `${s.side} window sill is only ${s.bottom.toFixed(2)} m up`)
    }
    if (
      s.floor === 0 &&
      PORCHED.has(b.kind) &&
      s.side === front &&
      s.top > PORCH_ROOF - PORCH_ROOF_T / 2 - 0.02
    ) {
      flag('error', id, 'window', `${s.side} window top ${s.top.toFixed(2)} clips the porch roof`)
    }
    if (s.floor === 0) {
      for (const d of b.doors.filter((q) => q.side === s.side)) {
        if (s.at + s.span > d.at - 0.65 && s.at < d.at + d.width + 0.65) {
          flag('warn', id, 'window', `${s.side} window is within 0.65 m of a door frame`)
        }
      }
    }
  }
  // Windows on the same side must not overlap.
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]
      const c = slots[j]
      if (!(a && c) || a.side !== c.side || a.floor !== c.floor) {
        continue
      }
      if (a.at < c.at + c.span && c.at < a.at + a.span) {
        flag('error', id, 'window', `${a.side} windows overlap on floor ${a.floor}`)
      }
    }
  }

  // Roofs.
  if (!b.roof) {
    flag(
      'error',
      id,
      'roof',
      'no roof spec: the sim cannot stand on it and the scene cannot build it',
    )
  } else if (b.roof.rise <= 0 || b.roof.bays < 1 || b.roof.overhang < 0) {
    flag('error', id, 'roof', 'invalid roof spec')
  }

  // Two-storey walk-ins need a real floor and a stair that reaches it.
  if (b.floors > 1 && b.hollow) {
    if (!b.upperFloor || b.upperFloor.length === 0) {
      flag('error', id, 'floor', `${b.floors} floors but no upper floor`)
    }
    if (!b.stairs || b.stairs.length === 0) {
      flag('error', id, 'floor', `${b.floors} floors but no stairs`)
    }
    for (const st of b.stairs ?? []) {
      if (st.fromY !== 0 || Math.abs(st.toY - 3.3) > 0.01) {
        flag('error', id, 'stair', 'stair does not run from the ground to the 3.3 m floor')
      }
      if (st.x < b.x || st.z < b.z || st.x + st.w > b.x + b.w || st.z + st.d > b.z + b.d) {
        flag('error', id, 'stair', 'stair runs outside the building')
      }
    }
    for (const w of b.walls ?? []) {
      if ((w.y0 ?? 0) > 0 && (w.y0 ?? 0) < 3.3) {
        flag('warn', id, 'wall', `upper wall starts at ${w.y0} m, below the 3.3 m floor`)
      }
    }
  }

  // Every room on every storey must be reachable from a door or the stair landing.
  if (b.hollow) {
    auditRooms(b, id)
  }

  // Closed doors on solid buildings.
  if (b.doors.length === 0 && sideLength(b, front) < 1.8) {
    flag('warn', id, 'door', 'solid building is too narrow for a closed door')
  }
}

const errors = issues.filter((i) => i.level === 'error')
const warnings = issues.filter((i) => i.level === 'warn')
if (asJson) {
  console.log(JSON.stringify({ buildings: TOWN.buildings.length, issues }, null, 2))
} else {
  for (const i of issues) {
    console.log(`${i.level === 'error' ? 'ERROR' : 'warn '} ${i.building} [${i.kind}] ${i.msg}`)
  }
  console.log(
    `\n${TOWN.buildings.length} buildings, ${errors.length} errors, ${warnings.length} warnings`,
  )
}
if (errors.length > 0) {
  process.exitCode = 1
}
