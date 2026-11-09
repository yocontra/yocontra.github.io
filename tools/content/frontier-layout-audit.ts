/** Actual PlayCanvas/Ammo clearance and traversal audit of the staged authoritative town. */
import { readFile, writeFile } from 'node:fs/promises'
import { townWindows, windowPane } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation, type Simulation } from '../../src/experiments/out-west/runtime/world.ts'
import { compileFrontierCollision } from './frontier-collision.ts'

function place(sim: Simulation, x: number, feet: number, z: number) {
  const old = sim.players.get('audit') ?? sim.addPlayer('audit')
  sim.adopt('audit', {
    ...old,
    x,
    y: feet + 0.9,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: false,
    crouched: false,
    lastButtons: 0,
    motion: newMotion(x, feet, z),
  })
  for (let i = 0; i < 15; i++) {
    sim.step(new Map())
  }
  return old
}
function cast(sim: Simulation, from: number[], to: number[]) {
  const [x = 0, y = 0, z = 0] = from
  const dx = (to[0] ?? 0) - x
  const dy = (to[1] ?? 0) - y
  const dz = (to[2] ?? 0) - z
  const length = Math.hypot(dx, dy, dz)
  const hit = sim.castWorld({
    ox: x,
    oy: y,
    oz: z,
    dx: dx / length,
    dy: dy / length,
    dz: dz / length,
    maxT: length,
  })
  return hit !== null && hit < length - 0.01
}
interface AuditReport {
  issues: unknown[]
  spawns: unknown[]
  doors: unknown[]
  stairs: unknown[]
  blockedPanes: number
  losPairs: number
  maxSpawnLos: number
  longLines: unknown[]
}

export async function auditFrontier(directory: string) {
  const layout = JSON.parse(await readFile(`${directory}/town.layout.json`, 'utf8')) as TownLayout
  const collision = compileFrontierCollision(layout)
  const ammo = await initializeAmmo(
    await WebAssembly.compile(
      await Bun.file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
  const sim = createSimulation({ ammo, collision })
  let report: AuditReport
  const configuration = JSON.parse(
    await readFile(`${directory}/frontier.json`, 'utf8'),
  ) as AmbientConfiguration
  try {
    report = inspectFrontier(sim, layout)
    auditAmbient(sim, configuration, report)
  } finally {
    sim.dispose()
  }
  const result = {
    collisionVersion: collision.version,
    panes: townWindows(layout).length,
    ...report,
  }
  await writeFile(`${directory}/native-layout-audit.json`, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    JSON.stringify({
      spawns: report.spawns.length,
      doors: report.doors.length,
      stairs: report.stairs.length,
      panes: result.panes,
      blockedPanes: report.blockedPanes,
      losPairs: report.losPairs,
      maxSpawnLos: report.maxSpawnLos,
      issues: report.issues,
    }),
  )
  return result
}
if (import.meta.main) {
  await auditFrontier(process.argv[2] ?? '/tmp/out-west-frontier-staged')
}

function auditSpawns(sim: Simulation, layout: TownLayout, report: AuditReport) {
  for (const [index, spawn] of layout.spawns.entries()) {
    const p = place(sim, spawn.x, 0.04, spawn.z)
    const displacement = Math.hypot(p.x - spawn.x, p.z - spawn.z)
    const valid = displacement < 0.12 && Math.abs(p.y - 0.93) < 0.18 && p.grounded
    report.spawns.push({
      index,
      ...spawn,
      displacement,
      feet: p.y - 0.9,
      grounded: p.grounded,
      valid,
    })
    if (!valid) {
      report.issues.push({
        kind: 'spawn',
        index,
        x: spawn.x,
        z: spawn.z,
        displacement,
        feet: p.y - 0.9,
      })
    }
  }
}

function auditDoors(sim: Simulation, layout: TownLayout, report: AuditReport) {
  for (const b of layout.buildings.filter((v) => v.hollow)) {
    for (const door of b.doors) {
      const horizontal = door.side === 'n' || door.side === 's'
      const normal = {
        n: [0, -1] as const,
        s: [0, 1] as const,
        e: [1, 0] as const,
        w: [-1, 0] as const,
      }[door.side]
      const nx = normal[0]
      const nz = normal[1]
      const edge = { n: b.z, s: b.z + b.d, e: b.x + b.w, w: b.x }[door.side]
      const along = (horizontal ? b.x : b.z) + door.at + door.width / 2
      const x = horizontal ? along : edge
      const z = horizontal ? edge : along
      const feet = door.y0 ?? 0.03
      const p = place(sim, x - nx * 0.9, feet + 0.02, z - nz * 0.9)
      const command = { ...neutralInput(), moveX: nx, moveZ: nz }
      let crossed = false
      for (let tick = 0; tick < 18; tick++) {
        sim.step(new Map([['audit', command]]))
        if ((p.x - x) * nx + (p.z - z) * nz > 0.55) {
          crossed = true
          break
        }
      }
      report.doors.push({
        building: b.id,
        side: door.side,
        at: door.at,
        feet,
        crossed,
        end: [p.x, p.y - 0.9, p.z],
      })
      if (!crossed) {
        report.issues.push({
          kind: 'door',
          building: b.id,
          side: door.side,
          at: door.at,
          feet,
          end: [p.x, p.y - 0.9, p.z],
        })
      }
    }
  }
}

function auditPanes(sim: Simulation, layout: TownLayout, report: AuditReport) {
  // Each pane center and four quarter samples must be a native bullet opening on both floors.
  for (const { b, w, index } of townWindows(layout)) {
    const pane = windowPane(b, w)
    let blocked = false
    for (const u of [0.25, 0.5, 0.75]) {
      for (const v of [0.25, 0.75]) {
        const along = pane.a0 + (pane.a1 - pane.a0) * u
        const y = pane.y0 + (pane.y1 - pane.y0) * v
        const from = pane.axis === 0 ? [pane.at - 0.8, y, along] : [along, y, pane.at - 0.8]
        const to = pane.axis === 0 ? [pane.at + 0.8, y, along] : [along, y, pane.at + 0.8]
        if (cast(sim, from, to)) {
          blocked = true
        }
      }
    }
    if (blocked) {
      report.blockedPanes++
      report.issues.push({ kind: 'pane', index, building: b.id, window: w.id })
    }
  }
}

function auditStairs(sim: Simulation, layout: TownLayout, report: AuditReport) {
  for (const b of layout.buildings) {
    for (const stair of b.stairs ?? []) {
      const normal = {
        n: [0, -1] as const,
        s: [0, 1] as const,
        e: [1, 0] as const,
        w: [-1, 0] as const,
      }[stair.dir]
      const nx = normal[0]
      const nz = normal[1]
      const cx = stair.x + stair.w / 2
      const cz = stair.z + stair.d / 2
      const span = stair.dir === 'n' || stair.dir === 's' ? stair.d : stair.w
      const p = place(
        sim,
        cx - nx * (span / 2 + 0.5),
        stair.fromY + 0.04,
        cz - nz * (span / 2 + 0.5),
      )
      let reached = false
      for (let tick = 0; tick < 55; tick++) {
        sim.step(new Map([['audit', { ...neutralInput(), moveX: nx, moveZ: nz }]]))
        if (p.y - 0.9 >= stair.toY - 0.12) {
          reached = true
          break
        }
      }
      report.stairs.push({ building: b.id, stair, reached, end: [p.x, p.y - 0.9, p.z] })
      if (!reached) {
        report.issues.push({ kind: 'stair', building: b.id, stair, end: [p.x, p.y - 0.9, p.z] })
      }
    }
  }
}

function auditLos(sim: Simulation, layout: TownLayout, report: AuditReport) {
  for (let a = 0; a < layout.spawns.length; a++) {
    for (let b = a + 1; b < layout.spawns.length; b++) {
      const first = layout.spawns[a]
      const last = layout.spawns[b]
      if (!(first && last)) {
        continue
      }
      const distance = Math.hypot(first.x - last.x, first.z - last.z)
      if (!cast(sim, [first.x, 1.65, first.z], [last.x, 1.65, last.z])) {
        report.losPairs++
        report.maxSpawnLos = Math.max(report.maxSpawnLos, distance)
        if (distance > 35) {
          report.longLines.push({ a, b, first, last, distance })
        }
      }
    }
  }
}

export function inspectFrontier(sim: Simulation, layout: TownLayout): AuditReport {
  const report: AuditReport = {
    issues: [],
    spawns: [],
    doors: [],
    stairs: [],
    blockedPanes: 0,
    losPairs: 0,
    maxSpawnLos: 0,
    longLines: [],
  }
  auditSpawns(sim, layout, report)
  auditDoors(sim, layout, report)
  auditStairs(sim, layout, report)
  auditPanes(sim, layout, report)
  auditLos(sim, layout, report)

  return report
}

interface AmbientConfiguration {
  life: {
    folk: {
      x: number
      y: number
      z: number
      seatY?: number
      support?: { index: number; floorY: number }
    }[]
    horses: { x: number; y: number; z: number }[]
    crowPerches: { x: number; y: number; z: number }[]
  }
  tumbleweedPaths: { center: [number, number]; radius: [number, number] }[]
}
function supportHeight(sim: Simulation, x: number, y: number, z: number): number | null {
  const hit = sim.castWorld({ ox: x, oy: y + 0.2, oz: z, dx: 0, dy: -1, dz: 0, maxT: 0.45 })
  return hit === null ? null : y + 0.2 - hit
}
function auditAmbient(sim: Simulation, config: AmbientConfiguration, report: AuditReport) {
  for (const horse of config.life.horses) {
    const floor = supportHeight(sim, horse.x, horse.y, horse.z)
    if (floor === null || Math.abs(floor - horse.y) > 0.03) {
      report.issues.push({ kind: 'horse-support', horse, floor })
    }
  }
  for (const crow of config.life.crowPerches) {
    const floor = supportHeight(sim, crow.x, crow.y, crow.z)
    if (floor === null || Math.abs(floor - crow.y) > 0.03) {
      report.issues.push({ kind: 'crow-perch', crow, floor })
    }
  }
  for (const folk of config.life.folk) {
    if (folk.seatY === undefined) {
      continue
    }
    const seat = supportHeight(sim, folk.x, folk.seatY, folk.z)
    const floor = supportHeight(sim, folk.x, folk.support?.floorY ?? folk.y, folk.z + 0.65)
    if (
      seat === null ||
      Math.abs(seat - folk.seatY) > 0.03 ||
      floor === null ||
      Math.abs(floor - (folk.support?.floorY ?? folk.y)) > 0.03
    ) {
      report.issues.push({ kind: 'seat-support', folk, seat, floor })
    }
  }
  for (const [index, route] of config.tumbleweedPaths.entries()) {
    auditRoller(sim, { index, route }, report)
  }
}
function auditRoller(
  sim: Simulation,
  roller: { index: number; route: AmbientConfiguration['tumbleweedPaths'][number] },
  report: AuditReport,
) {
  const { index, route } = roller
  const radius = 0.35 + index * 0.06
  for (let sample = 0; sample < 64; sample++) {
    const angle = (sample / 64) * Math.PI * 2
    const x = route.center[0] + Math.cos(angle) * route.radius[0]
    const z = route.center[1] + Math.sin(angle) * route.radius[1]
    const floor = supportHeight(sim, x, 0, z)
    const blocked = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].some((theta) =>
      cast(
        sim,
        [x, radius, z],
        [x + Math.cos(theta) * radius, radius, z + Math.sin(theta) * radius],
      ),
    )
    if (floor === null || Math.abs(floor) > 0.03 || blocked) {
      report.issues.push({ kind: 'tumbleweed-route', index, sample, x, z, floor, blocked })
    }
  }
}
