import { beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { CHANNEL_BANK, CHANNEL_STRONGBOX } from '../../src/experiments/out-west/contract/town.ts'
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { progressChannel, startChannel } from '../../src/experiments/out-west/ffa/sim/money.ts'
import { updatePickups } from '../../src/experiments/out-west/ffa/sim/pickups.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { addPlayer, chooseSpawn } from '../../src/experiments/out-west/ffa/sim/world.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'
import plan from '../../tools/art/environments/frontier.plan.json' with { type: 'json' }
import { compileFrontierCollision } from '../../tools/content/frontier-collision.ts'
import { inspectFrontier } from '../../tools/content/frontier-layout-audit.ts'

const layout = plan.layout as TownLayout
let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
it('native capsule traverses every authored doorway/stair and every spawn/opening is clear', () => {
  const sim = createSimulation({ ammo, collision: compileFrontierCollision(layout) })
  try {
    const report = inspectFrontier(sim, layout)
    expect(report.issues).toEqual([])
    expect(report.spawns).toHaveLength(layout.spawns.length)
    expect(report.doors.length).toBeGreaterThan(30)
    expect(report.stairs).toHaveLength(4)
    expect(report.blockedPanes).toBe(0)
    expect(report.maxSpawnLos).toBeLessThan(45)
  } finally {
    sim.dispose()
  }
})
it('balcony loot sits on the native floor and cannot be picked up through that floor', () => {
  const sim = createSimulation({ ammo, collision: compileFrontierCollision(layout) })
  const spot = layout.pickups.find((v) => v.id === 'rifle_balcony')
  if (!spot) {
    throw new Error('Missing balcony rifle')
  }
  const p = sim.addPlayer('balcony', [spot.x, (spot.y ?? 0) + 0.95, spot.z])
  try {
    for (let tick = 0; tick < 30; tick++) {
      sim.step(new Map())
    }
    expect(p.y - 0.9).toBeCloseTo(spot.y ?? 0, 2)
    const world = createWorld({ seed: 4, layout })
    const id = addPlayer(world, {
      name: 'Native balcony test',
      accountId: 'test',
      level: 1,
      prestige: 0,
      bot: false,
    })
    const rider = world.players[id]
    if (!rider) {
      throw new Error('Missing rider')
    }
    Object.assign(rider, { x: spot.x, z: spot.z, y: 0 })
    updatePickups(world)
    const pickup = world.pickups.find((v) => layout.pickups[v.spot]?.id === 'rifle_balcony')
    expect(pickup?.availableAt).toBe(0)
    rider.y = p.y - 0.9
    updatePickups(world)
    expect(pickup?.availableAt).toBeGreaterThan(0)
  } finally {
    sim.dispose()
  }
})
it('native spawn selection has a hard bound on static visibility queries at32human capacity', () => {
  const world = createWorld({ seed: 5, layout })
  for (let i = 0; i < 32; i++) {
    addPlayer(world, {
      name: `rider${i}`,
      accountId: `test${i}`,
      level: 1,
      prestige: 0,
      bot: false,
    })
  }
  let maximum = 0
  for (const self of world.players) {
    if (!self) {
      continue
    }
    let casts = 0
    world.castWorld = () => {
      casts++
      return 0
    }
    chooseSpawn(world, self)
    maximum = Math.max(maximum, casts)
  }
  expect(maximum).toBeLessThanOrEqual(96)
})
it('covered wagon native canvas blocks side shots while its visibly open ends stay open', () => {
  const wagon = layout.cover.find((c) => c.kind === 'covered_wagon')
  if (!wagon) {
    throw new Error('Missing authored covered wagon')
  }
  const sim = createSimulation({
    ammo,
    collision: compileFrontierCollision({ ...layout, buildings: [], cover: [wagon] }),
  })
  try {
    const x = wagon.x + wagon.w / 2 + 0.45
    const z = wagon.z + wagon.d / 2
    const side = sim.castWorld({
      ox: x,
      oy: 2,
      oz: wagon.z - 0.5,
      dx: 0,
      dy: 0,
      dz: 1,
      maxT: wagon.d + 1,
    })
    expect(side).not.toBeNull()
    const end = sim.castWorld({
      ox: wagon.x - 0.5,
      oy: 2,
      oz: z,
      dx: 1,
      dy: 0,
      dz: 0,
      maxT: wagon.w + 1,
    })
    expect(end).toBeNull()
  } finally {
    sim.dispose()
  }
})

it('bank service requires its actual native floor and cancels on moving above the counter', () => {
  const zone = layout.zones.find((v) => v.kind === 'bank')
  if (!zone) {
    throw new Error('Missing bank service')
  }
  const sim = createSimulation({ ammo, collision: compileFrontierCollision(layout) })
  try {
    const body = sim.addPlayer('upper-bank', [zone.x, 4.25, zone.z])
    for (let tick = 0; tick < 30; tick++) {
      sim.step(new Map())
    }
    expect(body.y - 0.9).toBeCloseTo(3.3, 2)
    const world = createWorld({ layout })
    const id = addPlayer(world, {
      name: 'Bank height',
      accountId: 'test',
      level: 1,
      prestige: 0,
      bot: false,
    })
    const p = world.players[id]
    if (!p) {
      throw new Error('Missing rider')
    }
    Object.assign(p, { x: zone.x, z: zone.z, y: body.y - 0.9, roof: 0, carried: 10, moving: false })
    startChannel(world, p, 0)
    expect(p.channel).toBeNull()
    p.y = zone.y ?? 0
    startChannel(world, p, 0)
    expect(p.channel?.kind).toBe(CHANNEL_BANK)
    p.y = body.y - 0.9
    progressChannel(world, p)
    expect(p.channel).toBeNull()
    expect(p.carried).toBe(10)
  } finally {
    sim.dispose()
  }
})
it('a hay-supported strongbox remains reachable from ground but not through an upper floor', () => {
  const spot = layout.strongboxes.find((v) => v.id === 'hay_barn')
  if (!spot) {
    throw new Error('Missing hay chest')
  }
  const world = createWorld({ layout })
  const id = addPlayer(world, {
    name: 'Chest height',
    accountId: 'test',
    level: 1,
    prestige: 0,
    bot: false,
  })
  const p = world.players[id]
  if (!p) {
    throw new Error('Missing rider')
  }
  world.strongbox = { spot: layout.strongboxes.indexOf(spot), value: 10, openedBy: -1, progress: 0 }
  Object.assign(p, { x: spot.x, z: spot.z, y: 3.3, roof: 0, moving: false })
  startChannel(world, p, 0)
  expect(p.channel).toBeNull()
  p.y = 0.03
  startChannel(world, p, 0)
  expect(p.channel?.kind).toBe(CHANNEL_STRONGBOX)
  p.y = 3.3
  progressChannel(world, p)
  expect(p.channel).toBeNull()
  expect(world.strongbox.openedBy).toBe(-1)
})
