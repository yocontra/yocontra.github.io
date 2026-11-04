// biome-ignore-all lint/suspicious/noConsole: a CLI audit reports to the terminal
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one self-contained level-design audit and its map render
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: grid sweeps and per-feature checks kept flat
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: the SVG render is one long, linear drawing
// biome-ignore-all lint/style/noMagicNumbers: thresholds in metres, named where they matter
/**
 * Level-design audit of Perdition (`ffa/town.layout.json`), no browser needed:
 *
 *   bun tools/town-audit.ts [--png=.playwright-mcp/map-audit.png] [--json]
 *
 * It builds the server's collision grid and checks the layout the way a level designer would:
 * spawns (clearance, facing, who can see them), doorways and bank windows (blocked? reachable from
 * how many sides?), sightlines down every street, open ground with no cover, pinch gaps between
 * colliders, cover with no visual handler or no vault height, and outskirts terrain or scatter
 * intruding into the playable square. It then renders an annotated top-down map (colliders,
 * visuals, spawns with facing, bank windows, pickups, strongboxes, sightlines, issues) to PNG.
 * Exit code 1 when any error-level issue remains.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import sharp from 'sharp'
import { Vector3 } from 'three'
import { COVER_VISUALS, decks } from '../src/experiments/out-west/ffa/scene/cover-kinds.ts'
import {
  OUTSKIRTS_SEED,
  outskirtsGeometry,
  outskirtsProps,
  terrainHeight,
} from '../src/experiments/out-west/ffa/scene/outskirts.ts'
import { PLAYER_RADIUS, SPAWN_LOS_DIST } from '../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  BLOCK_SIGHT,
  type Building,
  buildGrid,
  buildingWalls,
  cellAt,
  circleBlocked,
  hasLineOfSight,
  type Rect,
  rayGrid,
  spawnFacing,
  TOWN,
  type TownLayout,
} from '../src/experiments/out-west/ffa/sim/layout.ts'

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const pngOut = arg('png')
const asJson = process.argv.includes('--json')

const layoutPath = arg('layout')
const L: TownLayout = layoutPath
  ? (JSON.parse(readFileSync(layoutPath, 'utf8')) as TownLayout)
  : TOWN
const grid = buildGrid(L)
const S = L.size
const C = grid.cell
const N = grid.n

type Level = 'error' | 'warn' | 'info'
interface Issue {
  level: Level
  kind: string
  msg: string
  at: [number, number]
}
const issues: Issue[] = []
const flag = (level: Level, kind: string, msg: string, at: [number, number]) =>
  issues.push({ level, kind, msg, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10] })

const free = (x: number, z: number) => !circleBlocked(grid, { x, z, r: PLAYER_RADIUS }, BLOCK_MOVE)
const idx = (col: number, row: number) => row * N + col
const blockedCell = (col: number, row: number) =>
  ((grid.cells[idx(col, row)] ?? 0) & BLOCK_MOVE) !== 0

// ------------------------------------------------------------ walkability and reachability

/** Cells a player's centre can stand in. */
const walk = new Uint8Array(N * N)
for (let row = 0; row < N; row++) {
  for (let col = 0; col < N; col++) {
    walk[idx(col, row)] = free((col + 0.5) * C, (row + 0.5) * C) ? 1 : 0
  }
}
function flood(sx: number, sz: number): Uint8Array {
  const seen = new Uint8Array(N * N)
  const s = idx(Math.floor(sx / C), Math.floor(sz / C))
  if (!walk[s]) {
    return seen
  }
  const q = [s]
  seen[s] = 1
  while (q.length > 0) {
    const i = q.pop() ?? 0
    const col = i % N
    const row = Math.floor(i / N)
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const c = col + dc
      const r = row + dr
      if (c < 0 || r < 0 || c >= N || r >= N) {
        continue
      }
      const j = idx(c, r)
      if (walk[j] && !seen[j]) {
        seen[j] = 1
        q.push(j)
      }
    }
  }
  return seen
}
const main = L.streets[0] as Rect
const reach = flood(main.x + 20, main.z + main.d / 2)
const reached = (x: number, z: number) => reach[idx(Math.floor(x / C), Math.floor(z / C))] === 1

// pockets: walkable but unreachable regions (excluding sealed solid interiors)
{
  const seen = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i++) {
    if (!walk[i] || reach[i] || seen[i]) {
      continue
    }
    const q = [i]
    seen[i] = 1
    let n = 0
    let sx = 0
    let sz = 0
    while (q.length > 0) {
      const k = q.pop() ?? 0
      n++
      sx += (k % N) + 0.5
      sz += Math.floor(k / N) + 0.5
      for (const d of [1, -1, N, -N]) {
        const j = k + d
        if (j >= 0 && j < N * N && walk[j] && !reach[j] && !seen[j]) {
          seen[j] = 1
          q.push(j)
        }
      }
    }
    const area = n * C * C
    if (area >= 2) {
      flag('warn', 'pocket', `unreachable walkable pocket of ${area.toFixed(1)} m²`, [
        (sx / n) * C,
        (sz / n) * C,
      ])
    }
  }
}

// ------------------------------------------------------------ spawns

const spawnInfo = L.spawns.map((s, i) => {
  const face = spawnFacing(s, L)
  const dx = Math.cos(face)
  const dz = Math.sin(face)
  const ahead = rayGrid(grid, { ox: s.x, oz: s.z, dx, dz, maxDist: 60 }, BLOCK_SIGHT)
  // clearance: distance from the capsule's edge to the nearest blocking cell
  let clear = 9
  for (let r = PLAYER_RADIUS; r < PLAYER_RADIUS + 3; r += 0.1) {
    if (circleBlocked(grid, { x: s.x, z: s.z, r }, BLOCK_MOVE)) {
      clear = r - PLAYER_RADIUS
      break
    }
  }
  const seenBy = L.spawns.filter(
    (o, j) =>
      j !== i && Math.hypot(o.x - s.x, o.z - s.z) <= SPAWN_LOS_DIST && hasLineOfSight(grid, s, o),
  ).length
  if (!free(s.x, s.z)) {
    flag('error', 'spawn', `spawn ${i} is inside a collider`, [s.x, s.z])
  } else if (!reached(s.x, s.z)) {
    flag('error', 'spawn', `spawn ${i} is unreachable from main street`, [s.x, s.z])
  }
  if (clear < 0.4) {
    flag('warn', 'spawn', `spawn ${i} is ${clear.toFixed(1)} m from an obstacle`, [s.x, s.z])
  }
  if (ahead < (s.interior ? 3 : 6)) {
    flag('warn', 'spawn', `spawn ${i} faces a wall ${ahead.toFixed(1)} m away`, [s.x, s.z])
  }
  if (seenBy >= 4) {
    flag('warn', 'spawn', `spawn ${i} is in sight of ${seenBy} other spawns within 35 m`, [
      s.x,
      s.z,
    ])
  }
  return { i, face, ahead, clear, seenBy }
})

// ------------------------------------------------------------ doorways

const doorFront = (b: Building, side: string, at: number, width: number): Rect => {
  const depth = 1.6
  switch (side) {
    case 'n':
      return { x: b.x + at, z: b.z - depth, w: width, d: depth }
    case 's':
      return { x: b.x + at, z: b.z + b.d, w: width, d: depth }
    case 'e':
      return { x: b.x + b.w, z: b.z + at, w: depth, d: width }
    default:
      return { x: b.x - depth, z: b.z + at, w: depth, d: width }
  }
}
const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.z < b.z + b.d + pad && b.z < a.z + a.d + pad
for (const b of L.buildings) {
  for (const d of b.doors) {
    const front = doorFront(b, d.side, d.at, d.width)
    const mid = { x: front.x + front.w / 2, z: front.z + front.d / 2 }
    if (d.width < 1.6) {
      flag('warn', 'door', `${b.id} ${d.side} door is only ${d.width} m wide`, [mid.x, mid.z])
    }
    for (const c of L.cover) {
      if (overlaps(front, c)) {
        flag('error', 'door', `${c.kind} blocks ${b.id}'s ${d.side} door`, [mid.x, mid.z])
      }
    }
    for (const o of L.buildings) {
      if (o !== b && overlaps(front, o)) {
        flag('error', 'door', `${o.id} blocks ${b.id}'s ${d.side} door`, [mid.x, mid.z])
      }
    }
    if (!reached(mid.x, mid.z)) {
      flag('error', 'door', `${b.id}'s ${d.side} door opens onto unreachable ground`, [
        mid.x,
        mid.z,
      ])
    }
  }
}

// ------------------------------------------------------------ bank windows

const bank = L.buildings.find((b) => b.kind === 'bank')
for (const z of L.zones) {
  if (!reached(z.x, z.z)) {
    flag('error', 'bank', `${z.id} is unreachable`, [z.x, z.z])
  }
}
if (bank) {
  const sides = new Set(bank.doors.map((d) => d.side))
  if (sides.size < 3) {
    flag('warn', 'bank', `the bank opens on only ${sides.size} sides`, [
      bank.x + bank.w / 2,
      bank.z + bank.d / 2,
    ])
  }
}

// ------------------------------------------------------------ sightlines

interface Lane {
  x0: number
  z0: number
  x1: number
  z1: number
  open: boolean
}
const lanes: Lane[] = []
/**
 * Longest unbroken sight corridor along each street: a body-wide (1 m) corridor walked down the
 * street on lines 1 m apart; any sight-blocking cell within half a metre of the line breaks it
 * (you can't see a rider whole past a coach's corner).
 */
const SIGHT_MAX = 50
const sightAt = (x: number, z: number, alongX: boolean) =>
  [-0.5, 0, 0.5].some(
    (o) => (cellAt(grid, alongX ? x : x + o, alongX ? z + o : z) & BLOCK_SIGHT) !== 0,
  )
const sightReport: string[] = []
for (const st of L.streets) {
  const along = st.w >= st.d
  const len = along ? st.w : st.d
  const across = along ? st.d : st.w
  let worst: Lane | null = null
  let worstLen = 0
  for (let a = 1; a < across; a += 1) {
    let start = 0
    for (let t = 0; t <= len; t += 0.5) {
      const x = along ? st.x + t : st.x + a
      const z = along ? st.z + a : st.z + t
      if (sightAt(x, z, along) || t >= len) {
        const run = t - start
        if (run > worstLen) {
          worstLen = run
          worst = along
            ? { x0: st.x + start, z0: z, x1: st.x + t, z1: z, open: true }
            : { x0: x, z0: st.z + start, x1: x, z1: st.z + t, open: true }
        }
        start = t + 0.5
      }
    }
  }
  if (worst) {
    lanes.push(worst)
    sightReport.push(`${st.id} ${worstLen.toFixed(0)} m`)
    if (worstLen > SIGHT_MAX) {
      flag(
        'warn',
        'sightline',
        `${st.id}: ${worstLen.toFixed(0)} m unbroken sightline (revolver range 22 m, rifle 35 m)`,
        [(worst.x0 + worst.x1) / 2, (worst.z0 + worst.z1) / 2],
      )
    }
  }
}

// ------------------------------------------------------------ exposure (open ground with no cover)

/** Distance (m) from each reachable cell to the nearest move-blocking cell, by BFS. */
const dist = new Float32Array(N * N).fill(1e9)
{
  const q: number[] = []
  for (let i = 0; i < N * N; i++) {
    if (blockedCell(i % N, Math.floor(i / N))) {
      dist[i] = 0
      q.push(i)
    }
  }
  // the queue grows as it is walked (for-of visits the pushed cells too)
  for (const i of q) {
    const col = i % N
    const row = Math.floor(i / N)
    for (const [dc, dr, w] of [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ] as const) {
      const c = col + dc
      const r = row + dr
      if (c < 0 || r < 0 || c >= N || r >= N) {
        continue
      }
      const j = idx(c, r)
      const nd = (dist[i] ?? 0) + w * C
      if (nd < (dist[j] ?? 0)) {
        dist[j] = nd
        q.push(j)
      }
    }
  }
}
const EXPOSED = 9
{
  // cluster exposed cells into blobs, one issue per blob
  const seen = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i++) {
    if (seen[i] || !reach[i] || (dist[i] ?? 0) < EXPOSED) {
      continue
    }
    const q = [i]
    seen[i] = 1
    let n = 0
    let best = i
    while (q.length > 0) {
      const k = q.pop() ?? 0
      n++
      if ((dist[k] ?? 0) > (dist[best] ?? 0)) {
        best = k
      }
      for (const d of [1, -1, N, -N]) {
        const j = k + d
        if (j >= 0 && j < N * N && !seen[j] && reach[j] && (dist[j] ?? 0) >= EXPOSED) {
          seen[j] = 1
          q.push(j)
        }
      }
    }
    if (n * C * C < 12) {
      continue
    }
    flag(
      'warn',
      'exposed',
      `open ground ${((dist[best] ?? 0) * 2).toFixed(0)} m across with no cover (${(n * C * C).toFixed(0)} m²)`,
      [((best % N) + 0.5) * C, (Math.floor(best / N) + 0.5) * C],
    )
  }
}

// ------------------------------------------------------------ colliders: gaps, overlaps, tags

interface Solid {
  name: string
  r: Rect
  low: boolean
}
const solids: Solid[] = [
  ...L.buildings.flatMap((b) => buildingWalls(b).map((r) => ({ name: b.id, r, low: false }))),
  ...L.cover.map((c, i) => ({ name: `${c.kind}#${i}`, r: c as Rect, low: c.low })),
]
const gapBetween = (a: Rect, b: Rect) => {
  const gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0)
  const gz = Math.max(a.z - (b.z + b.d), b.z - (a.z + a.d), 0)
  return Math.hypot(gx, gz)
}
for (let i = 0; i < solids.length; i++) {
  const a = solids[i] as Solid
  for (let j = i + 1; j < solids.length; j++) {
    const b = solids[j] as Solid
    if (a.name === b.name) {
      continue
    }
    const g = gapBetween(a.r, b.r)
    if (g > 0.01 && g < PLAYER_RADIUS * 2 + 0.1) {
      const mx = (Math.max(a.r.x, b.r.x) + Math.min(a.r.x + a.r.w, b.r.x + b.r.w)) / 2
      const mz = (Math.max(a.r.z, b.r.z) + Math.min(a.r.z + a.r.d, b.r.z + b.r.d)) / 2
      if ((cellAt(grid, mx, mz) & BLOCK_MOVE) !== 0) {
        // something else (a wall between them) already fills the gap
        continue
      }
      flag(
        'warn',
        'pinch',
        `${g.toFixed(2)} m gap between ${a.name} and ${b.name}: looks passable, isn't`,
        [mx, mz],
      )
    }
  }
}
for (const [i, a] of L.buildings.entries()) {
  for (const b of L.buildings.slice(i + 1)) {
    if (overlaps(a, b, -0.01)) {
      flag('error', 'overlap', `${a.id} and ${b.id} overlap`, [
        (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2,
        (Math.max(a.z, b.z) + Math.min(a.z + a.d, b.z + b.d)) / 2,
      ])
    }
  }
}
for (const [i, c] of L.cover.entries()) {
  const at: [number, number] = [c.x + c.w / 2, c.z + c.d / 2]
  if (!COVER_VISUALS[c.kind]) {
    flag('error', 'invisible', `${c.kind}#${i} has no visual: an invisible wall`, at)
  }
  if (c.low && COVER_VISUALS[c.kind]?.vault && !c.vaultHeight) {
    flag('warn', 'vault', `${c.kind}#${i} is low cover with no vaultHeight`, at)
  }
  for (const b of L.buildings) {
    if (buildingWalls(b).some((w) => overlaps(c, w))) {
      flag('error', 'overlap', `${c.kind}#${i} overlaps ${b.id}'s walls`, at)
    }
  }
  for (const [j, o] of L.cover.entries()) {
    if (j > i && overlaps(c, o)) {
      flag('warn', 'overlap', `${c.kind}#${i} overlaps ${o.kind}#${j}`, at)
    }
  }
  for (const st of L.streets) {
    if (!c.low && overlaps(c, st)) {
      flag('info', 'street', `tall ${c.kind}#${i} breaks sight down ${st.id}`, at)
    }
  }
}

// ------------------------------------------------------------ outskirts intruding into play

const intrusions: [number, number, string][] = []
{
  const playable = (x: number, z: number) =>
    x > C &&
    x < S - C &&
    z > L.creek.z &&
    z < S - C &&
    walk[idx(Math.floor(x / C), Math.floor(z / C))]
  for (let z = L.creek.z; z < S; z += 0.5) {
    for (let x = 0.5; x < S; x += 0.5) {
      if (playable(x, z) && terrainHeight(L, x, z) > 0.08) {
        intrusions.push([x, z, 'terrain'])
      }
    }
  }
  const land = outskirtsProps(L, OUTSKIRTS_SEED)
  for (const m of land.rock) {
    const e = m.elements
    if (playable(e[12] ?? 0, e[14] ?? 0)) {
      intrusions.push([e[12] ?? 0, e[14] ?? 0, 'rock'])
    }
  }
  const geo = outskirtsGeometry(L, OUTSKIRTS_SEED, new Vector3(0.5, 0.6, 0.4).normalize())
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    if (y > 0.08 && playable(x, z)) {
      intrusions.push([x, z, 'mound'])
    }
  }
  const byKind = new Map<string, [number, number][]>()
  for (const [x, z, k] of intrusions) {
    byKind.set(k, [...(byKind.get(k) ?? []), [x, z]])
  }
  for (const [k, pts] of byKind) {
    const xs = pts.map((p) => p[0])
    const zs = pts.map((p) => p[1])
    flag(
      'error',
      'dirt',
      `${pts.length} outskirts ${k} samples stand on walkable ground inside the town (x ${Math.min(...xs).toFixed(0)}–${Math.max(...xs).toFixed(0)}, z ${Math.min(...zs).toFixed(0)}–${Math.max(...zs).toFixed(0)})`,
      [pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0],
    )
  }
}

// ------------------------------------------------------------ report

const counts = { error: 0, warn: 0, info: 0 }
for (const i of issues) {
  counts[i.level]++
}
const shown = issues.filter((i) => i.level !== 'info')
if (asJson) {
  console.log(JSON.stringify({ counts, issues, spawns: spawnInfo }, null, 2))
} else {
  console.log(
    `Perdition audit: ${L.buildings.length} buildings, ${L.cover.length} cover, ${L.spawns.length} spawns, ${L.zones.length} zones`,
  )
  console.log(
    `  errors ${counts.error}  warnings ${counts.warn}  (sightlines: ${sightReport.join(', ')})`,
  )
  for (const [n, i] of shown.entries()) {
    console.log(
      `  ${String(n + 1).padStart(3)} ${i.level.padEnd(5)} ${i.kind.padEnd(10)} (${i.at[0]}, ${i.at[1]})  ${i.msg}`,
    )
  }
}

// ------------------------------------------------------------ map render

if (pngOut) {
  const K = 7
  const pad = 20
  const legendW = 300
  const W = S * K + pad * 2 + legendW
  const H = S * K + pad * 2
  const X = (x: number) => (pad + x * K).toFixed(1)
  const Z = (z: number) => (pad + z * K).toFixed(1)
  const rect = (r: Rect, fill: string, extra = '') =>
    `<rect x="${X(r.x)}" y="${Z(r.z)}" width="${(r.w * K).toFixed(1)}" height="${(r.d * K).toFixed(1)}" fill="${fill}" ${extra}/>`
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`,
  )
  out.push(`<rect width="${W}" height="${H}" fill="#f4ecdc"/>`)
  out.push(rect({ x: 0, z: 0, w: S, d: S }, '#e2cfa8'))
  // exposure heat
  for (let row = 0; row < N; row += 2) {
    for (let col = 0; col < N; col += 2) {
      const d = dist[idx(col, row)] ?? 0
      if (reach[idx(col, row)] && d >= EXPOSED * 0.75) {
        const a = Math.min(0.45, ((d - EXPOSED * 0.75) / EXPOSED) * 0.6 + 0.08)
        out.push(
          rect({ x: col * C, z: row * C, w: C * 2, d: C * 2 }, `rgba(220,40,40,${a.toFixed(2)})`),
        )
      }
    }
  }
  for (const st of L.streets) {
    out.push(rect(st, 'rgba(150,110,70,0.25)'))
    out.push(
      `<text x="${X(st.x + 1)}" y="${Z(st.z + 2.2)}" font-size="10" fill="#6a4a2a">${st.id}</text>`,
    )
  }
  // porches and the depot platform, and the railroad between its buffer stops
  for (const dk of decks(L)) {
    out.push(rect(dk, '#c8a070'))
  }
  const buffers = L.cover.filter((c) => c.kind === 'buffer')
  if (buffers.length >= 2) {
    const xs = buffers.map((c) => c.x + c.w / 2)
    const tz = (buffers[0]?.z ?? 0) + (buffers[0]?.d ?? 0) / 2
    out.push(
      rect(
        { x: Math.min(...xs), z: tz - 1.1, w: Math.max(...xs) - Math.min(...xs), d: 2.2 },
        'rgba(70,60,50,0.45)',
      ),
    )
  }
  const cr = L.creek
  out.push(rect(cr, 'rgba(80,130,150,0.35)'))
  out.push(rect(cr.bridge, '#a07a50'))
  for (const b of cr.banks) {
    out.push(rect(b, '#7a5a3a'))
  }
  // blocked border/creek strip
  out.push(rect({ x: 0, z: 0, w: S, d: Math.max(C, cr.z) }, 'rgba(60,40,30,0.5)'))
  // unreachable walkable pockets
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const i = idx(col, row)
      if (walk[i] && !reach[i]) {
        out.push(rect({ x: col * C, z: row * C, w: C, d: C }, 'rgba(140,0,180,0.35)'))
      }
    }
  }
  for (const b of L.buildings) {
    const fill = b.hollow ? '#d8c4a4' : '#9a8068'
    out.push(rect(b, b.kind === 'bank' ? '#f0d890' : fill))
    for (const w of buildingWalls(b)) {
      out.push(rect(w, '#3a2a1e'))
    }
    out.push(
      `<text x="${X(b.x + b.w / 2)}" y="${Z(b.z + b.d / 2)}" font-size="11" text-anchor="middle" fill="#1a120a" font-weight="bold">${b.id}</text>`,
    )
    for (const d of b.doors) {
      const f = doorFront(b, d.side, d.at, d.width)
      out.push(rect(f, 'rgba(40,160,60,0.35)'))
    }
  }
  for (const c of L.cover) {
    let fill = '#6a2a1a'
    if (c.low && c.vaultHeight) {
      fill = '#c07830'
    } else if (c.low) {
      fill = COVER_VISUALS[c.kind]?.vault ? '#e05a20' : '#9a8a70'
    }
    // biome-ignore lint/security/noSecrets: an SVG attribute, not a secret
    out.push(rect(c, fill, 'stroke="#2a1a10" stroke-width="0.6"'))
  }
  for (const [x, z, k] of intrusions) {
    out.push(
      `<circle cx="${X(x)}" cy="${Z(z)}" r="${k === 'terrain' ? 1.2 : 2.2}" fill="#d020c0" opacity="0.8"/>`,
    )
  }
  for (const ln of lanes) {
    out.push(
      `<line x1="${X(ln.x0)}" y1="${Z(ln.z0)}" x2="${X(ln.x1)}" y2="${Z(ln.z1)}" stroke="#2050e0" stroke-width="2" stroke-dasharray="6 4"/>`,
    )
  }
  for (const s of spawnInfo) {
    const sp = L.spawns[s.i]
    if (!sp) {
      continue
    }
    const bad = s.ahead < (sp.interior ? 3 : 6) || s.clear < 0.4 || s.seenBy >= 4
    const col = bad ? '#e02020' : '#1a8a3a'
    const ex = sp.x + Math.cos(s.face) * 3.5
    const ez = sp.z + Math.sin(s.face) * 3.5
    out.push(
      `<line x1="${X(sp.x)}" y1="${Z(sp.z)}" x2="${X(ex)}" y2="${Z(ez)}" stroke="${col}" stroke-width="2.5"/>`,
    )
    out.push(
      `<circle cx="${X(sp.x)}" cy="${Z(sp.z)}" r="5" fill="${sp.interior ? '#ffffff' : col}" stroke="${col}" stroke-width="2"/>`,
    )
    out.push(
      `<text x="${X(sp.x + 1)}" y="${Z(sp.z - 1)}" font-size="9" fill="${col}">S${s.i}</text>`,
    )
  }
  for (const z of L.zones) {
    out.push(
      `<circle cx="${X(z.x)}" cy="${Z(z.z)}" r="${(z.r * K).toFixed(1)}" fill="${z.kind === 'bank' ? '#ffd020' : '#40c0a0'}" stroke="#5a3a00" stroke-width="1.5"/>`,
    )
    out.push(
      `<text x="${X(z.x)}" y="${Z(z.z + 0.6)}" font-size="9" text-anchor="middle" font-weight="bold">${z.kind === 'bank' ? '$' : 'ST'}</text>`,
    )
  }
  for (const b of L.strongboxes) {
    out.push(
      `<rect x="${(pad + b.x * K - 5).toFixed(1)}" y="${(pad + b.z * K - 5).toFixed(1)}" width="10" height="10" fill="#8a5a20" stroke="#ffe080" stroke-width="2"/>`,
    )
  }
  for (const p of L.pickups) {
    const col = { rifle: '#2060c0', shotgun: '#802080', dynamite: '#d02020' }[p.kind]
    out.push(
      `<polygon points="${X(p.x)},${(pad + p.z * K - 7).toFixed(1)} ${(pad + p.x * K + 7).toFixed(1)},${Z(p.z)} ${X(p.x)},${(pad + p.z * K + 7).toFixed(1)} ${(pad + p.x * K - 7).toFixed(1)},${Z(p.z)}" fill="${col}" stroke="#fff" stroke-width="1.5"/>`,
    )
  }
  for (const [n, i] of shown.entries()) {
    if (i.kind === 'dirt') {
      continue
    }
    const col = i.level === 'error' ? '#c00000' : '#d07000'
    out.push(
      `<circle cx="${X(i.at[0])}" cy="${Z(i.at[1])}" r="7" fill="none" stroke="${col}" stroke-width="2"/>`,
    )
    out.push(
      `<text x="${(pad + i.at[0] * K + 8).toFixed(1)}" y="${(pad + i.at[1] * K + 4).toFixed(1)}" font-size="10" font-weight="bold" fill="${col}">${n + 1}</text>`,
    )
  }
  // grid ticks every 8 m
  for (let m = 0; m <= S; m += 8) {
    out.push(`<text x="${X(m)}" y="${pad - 6}" font-size="8" fill="#7a6a5a">${m}</text>`)
    out.push(`<text x="2" y="${Z(m)}" font-size="8" fill="#7a6a5a">${m}</text>`)
  }
  const lx = S * K + pad * 2 + 10
  const legend: [string, string][] = [
    ['#3a2a1e', 'building wall (blocks all)'],
    ['#6a2a1a', 'tall cover (blocks sight)'],
    ['#c07830', 'low cover, vaultable'],
    ['#e05a20', 'low cover, missing vaultHeight'],
    ['#9a8a70', 'low cover, not vaultable (well, post, forge)'],
    ['rgba(40,160,60,0.6)', 'doorway approach'],
    ['#ffd020', 'bank window ($)'],
    ['#40c0a0', 'stage-line counter'],
    ['#8a5a20', 'strongbox spot'],
    ['#2060c0', 'pickup (blue rifle, purple shotgun, red dynamite)'],
    ['#1a8a3a', 'spawn + facing (white = interior)'],
    ['#e02020', 'spawn with an issue'],
    ['rgba(220,40,40,0.4)', `open ground > ${EXPOSED * 2} m from cover`],
    ['rgba(140,0,180,0.5)', 'unreachable pocket'],
    ['#d020c0', 'outskirts mound/rock in play'],
    ['#2050e0', 'longest sightline per street'],
  ]
  out.push(
    `<text x="${lx}" y="${pad + 4}" font-size="16" font-weight="bold">Perdition: ${counts.error} errors, ${counts.warn} warnings</text>`,
  )
  for (const [k, [c, t]] of legend.entries()) {
    const y = pad + 26 + k * 20
    out.push(`<rect x="${lx}" y="${y - 10}" width="14" height="14" fill="${c}"/>`)
    out.push(`<text x="${lx + 20}" y="${y + 1}" font-size="11">${t}</text>`)
  }
  let y = pad + 26 + legend.length * 20 + 14
  for (const [n, i] of shown.entries()) {
    if (y > H - 12) {
      out.push(
        `<text x="${lx}" y="${y}" font-size="9">… ${shown.length - n} more (see console)</text>`,
      )
      break
    }
    const text = `${n + 1}. ${i.msg}`.replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    out.push(
      `<text x="${lx}" y="${y}" font-size="8.5" fill="${i.level === 'error' ? '#a00000' : '#7a4a00'}">${text.length > 62 ? `${text.slice(0, 61)}…` : text}</text>`,
    )
    y += 11
  }
  out.push('</svg>')
  const svg = out.join('\n')
  writeFileSync(pngOut.replace(/\.png$/u, '.svg'), svg)
  await sharp(Buffer.from(svg)).png().toFile(pngOut)
  console.log(`map: ${pngOut}`)
}
process.exit(counts.error > 0 ? 1 : 0)
