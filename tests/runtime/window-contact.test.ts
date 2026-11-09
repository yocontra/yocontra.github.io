import { beforeAll, expect, test as it } from 'bun:test'
import { Encoder } from '@colyseus/schema'
import { Room } from '@colyseus/sdk'
import { file } from 'bun'
import { Entity } from 'playcanvas'
import { applyFrontierState } from '../../src/experiments/out-west/client/state.ts'
import { BreakableWindows } from '../../src/experiments/out-west/client/windows.ts'
import { COLLISION_VERSION } from '../../src/experiments/out-west/content/manifest.ts'
import { BTN_CROUCH, BTN_JUMP } from '../../src/experiments/out-west/contract/town.ts'
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { addPlayer } from '../../src/experiments/out-west/ffa/sim/world.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { createFrontierSimulation } from '../../src/experiments/out-west/runtime/frontier.ts'
import {
  Buttons,
  neutralInput,
  PROTOCOL_VERSION,
} from '../../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState } from '../../src/experiments/out-west/runtime/schema.ts'
import { bindWindowContacts } from '../../src/experiments/out-west/runtime/window-contact.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'
import plan from '../../tools/art/environments/frontier.plan.json' with { type: 'json' }
import { compileFrontierCollision } from '../../tools/content/frontier-collision.ts'

const layout = plan.layout as TownLayout
let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
function fixture() {
  const sim = createFrontierSimulation({
    ammo,
    layout,
    collision: compileFrontierCollision(layout),
  })
  const id = addPlayer(sim.world, {
    name: 'Glass contact',
    accountId: 'test',
    level: 1,
    prestige: 0,
    bot: false,
  })
  const player = sim.world.players[id]
  if (!player) {
    throw new Error('Missing native rider')
  }
  Object.assign(player, { x: 5.85, y: 0, z: 22.7 })
  for (let tick = 0; tick < 15; tick++) {
    sim.step([])
  }
  return { sim, player, id }
}
function jumpThrough(value: ReturnType<typeof fixture>): number {
  let breaks = 0
  for (let tick = 0; tick < 25; tick++) {
    value.sim.step([
      {
        seq: tick,
        moveX: 0,
        moveZ: 127,
        aim: 16_384,
        buttons: BTN_JUMP | BTN_CROUCH,
        viewTime: value.sim.world.tick,
      },
    ])
    breaks += value.sim.world.events.filter(
      (e) => e.type === 'glass_break' && e.window === 0,
    ).length
  }
  return breaks
}
it('actual native crouch/jump capsule contact breaks its pane exactly once', () => {
  const f = fixture()
  try {
    expect(f.sim.world.glass[0]).toBe(0)
    expect(jumpThrough(f)).toBe(1)
    expect(f.player.z).toBeGreaterThan(25)
    expect(f.sim.world.glass[0]).toBe(1)
  } finally {
    f.sim.dispose()
  }
})
it('spawn, teleport, direct native discontinuity and dead bodies do not break panes', () => {
  const f = fixture()
  try {
    Object.assign(f.player, { x: 5.85, y: 1, z: 24.25, spawnTick: f.player.spawnTick + 1 })
    f.sim.step([])
    expect(f.sim.world.glass[0]).toBe(0)
    Object.assign(f.player, { x: 10, y: 0, z: 20 })
    f.sim.step([])
    Object.assign(f.player, { x: 5.85, y: 1, z: 24.25 })
    f.sim.step([])
    expect(f.sim.world.glass[0]).toBe(0)
    Object.assign(f.player, { x: 5.85, y: 0, z: 22.7 })
    for (let tick = 0; tick < 15; tick++) {
      f.sim.step([])
    }
    const pose = f.sim.physics.players.get(String(f.id))
    if (!pose) {
      throw new Error('Missing body')
    }
    f.sim.physics.adopt(String(f.id), {
      ...pose,
      x: 5.85,
      y: 1.9,
      z: 24.25,
      motion: newMotion(5.85, 1, 24.25),
    })
    f.sim.step([])
    expect(f.sim.world.glass[0]).toBe(0)
    Object.assign(f.player, {
      alive: false,
      respawnTick: f.sim.world.tick + 100,
      x: 5.85,
      y: 1,
      z: 24.25,
    })
    f.sim.step([])
    expect(f.sim.world.glass[0]).toBe(0)
  } finally {
    f.sim.dispose()
  }
})
it('body-break state and reset survive real SDK encoding and native pane entity toggles', () => {
  const f = fixture()
  const town = new Entity('town', f.sim.physics.app)
  const pane = new Entity('glass-0', f.sim.physics.app)
  town.addChild(pane)
  f.sim.physics.app.root.addChild(town)
  const windows = new BreakableWindows(town)
  const state = new FrontierState()
  state.protocol = PROTOCOL_VERSION
  state.content = COLLISION_VERSION
  const data = () =>
    JSON.stringify({
      bags: [],
      strongbox: null,
      pickups: [],
      fuses: [],
      showdowns: [],
      mostWanted: 255,
      glass: [...f.sim.world.glass],
    })
  state.game = data()
  const encoder = new Encoder(state)
  const room = new Room<unknown, FrontierState>('window-contact', FrontierState)
  room.serializer.setState(encoder.encodeAll())
  const client = createWorld({ layout })
  const sync = () => {
    applyFrontierState(room.state, client, new Map(), new Map())
    windows.update(client.glass)
  }
  try {
    sync()
    expect(pane.enabled).toBe(true)
    expect(jumpThrough(f)).toBe(1)
    state.game = data()
    room.serializer.patch(encoder.encode())
    encoder.discardChanges()
    sync()
    expect(client.glass[0]).toBe(1)
    expect(pane.enabled).toBe(false)
    f.sim.world.glass.fill(0)
    state.game = data()
    room.serializer.patch(encoder.encode())
    encoder.discardChanges()
    sync()
    expect(client.glass[0]).toBe(0)
    expect(pane.enabled).toBe(true)
    state.content = 'stale-map'
    room.serializer.patch(encoder.encode())
    expect(sync).toThrow('Reload')
  } finally {
    town.destroy()
    f.sim.dispose()
  }
})

function sensorSimulation(ground: number, pane: { y0: number; y1: number }) {
  const options = {
    ammo,
    collision: {
      version: 'native-sensor-query',
      boxes: [
        {
          center: [0, ground - 0.5, 0] as [number, number, number],
          halfExtents: [10, 0.5, 10] as [number, number, number],
        },
        {
          center: [1.5, ground + 0.15, 0] as [number, number, number],
          halfExtents: [0.4, 0.15, 0.7] as [number, number, number],
        },
      ],
      meshes: [],
    },
  }
  const baseline = createSimulation(options)
  const sensor = createSimulation(options)
  const world = createWorld({ layout })
  world.grid = { ...world.grid, glass: [{ index: 0, axis: 0, at: 0, a0: -1, a1: 1, ...pane }] }
  world.glass = new Uint8Array(1)
  const release = bindWindowContacts({ world, physics: sensor, eligible: new Set() })
  return { baseline, sensor, release }
}
it('pane sensors cannot create fake ground or a jump impulse in midair', () => {
  const f = sensorSimulation(-2, { y0: -0.1, y1: 0.1 })
  try {
    const a = f.baseline.addPlayer('probe', [0, 0.95, 0])
    const b = f.sensor.addPlayer('probe', [0, 0.95, 0])
    const input = new Map([['probe', { ...neutralInput(), buttons: Buttons.jump }]])
    f.baseline.step(input)
    f.sensor.step(input)
    expect(a.vy).toBeLessThan(0)
    expect(b.vy).toBeCloseTo(a.vy, 6)
    expect(b.y).toBeCloseTo(a.y, 6)
  } finally {
    f.release()
    f.baseline.dispose()
    f.sensor.dispose()
  }
})
it('pane sensors preserve native uncrouch head clearance and physical step trajectories', () => {
  const f = sensorSimulation(0, { y0: 1.35, y1: 2.5 })
  try {
    const a = f.baseline.addPlayer('probe', [0, 0.95, 0])
    const b = f.sensor.addPlayer('probe', [0, 0.95, 0])
    for (let tick = 0; tick < 20; tick++) {
      f.baseline.step(new Map())
      f.sensor.step(new Map())
    }
    const crouch = new Map([['probe', { ...neutralInput(), buttons: Buttons.crouch }]])
    f.baseline.step(crouch)
    f.sensor.step(crouch)
    expect(a.crouched).toBe(true)
    expect(b.crouched).toBe(true)
    f.baseline.step(new Map())
    f.sensor.step(new Map())
    expect(a.crouched).toBe(false)
    expect(b.crouched).toBe(false)
    for (let tick = 0; tick < 25; tick++) {
      const input = new Map([['probe', { ...neutralInput(), moveX: 1 }]])
      f.baseline.step(input)
      f.sensor.step(input)
      expect(b.x).toBeCloseTo(a.x, 5)
      expect(b.y).toBeCloseTo(a.y, 5)
    }
  } finally {
    f.release()
    f.baseline.dispose()
    f.sensor.dispose()
  }
})
