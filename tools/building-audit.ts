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
