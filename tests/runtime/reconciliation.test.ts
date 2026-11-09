import { beforeAll, expect, test as it } from 'bun:test'
import { Encoder } from '@colyseus/schema'
import { Predict, Room } from '@colyseus/sdk'
import { file } from 'bun'
import {
  playerLifetimeSync,
  REMOTE_POSE,
} from '../../src/experiments/out-west/client/prediction-lifecycle.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { Buttons, neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import {
  FrontierState,
  MoveInput,
  PlayerRecord,
} from '../../src/experiments/out-west/runtime/schema.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})

function simulation() {
  return createSimulation({
    ammo,
    collision: {
      version: 'reconciliation',
      boxes: [{ center: [0, -0.5, 0], halfExtents: [20, 0.5, 20] }],
      meshes: [],
    },
  })
}

it('native rollback restores the acknowledged jump edge before replay', () => {
  const sim = simulation()
  try {
    const player = sim.addPlayer('self')
    for (let tick = 0; tick < 40; tick++) {
      sim.step(new Map())
    }
    const ack = structuredClone(player)
    const jump = { ...neutralInput(), seq: 1, buttons: Buttons.jump }
    sim.step(new Map([['self', jump]]))
    const expected = { y: player.y, vy: player.vy }
    expect(expected.vy).toBeGreaterThan(5)
    sim.adopt('self', structuredClone(ack))
    sim.step(new Map([['self', jump]]))
    expect(player.y).toBeCloseTo(expected.y, 5)
    expect(player.vy).toBeCloseTo(expected.vy, 5)
    for (let tick = 0; tick < 40; tick++) {
      sim.step(new Map([['self', jump]]))
    }
    expect(player.grounded).toBe(true)
    const heldAck = structuredClone(player)
    sim.step(new Map([['self', neutralInput()]]))
    sim.adopt('self', heldAck)
    sim.step(new Map([['self', jump]]))
    expect(player.grounded).toBe(true)
    expect(Math.abs(player.vy)).toBeLessThan(0.01)
  } finally {
    sim.dispose()
  }
})

it('decoded native SDK players cut to every new life without carrying interpolation history', () => {
  const state = new FrontierState()
  for (const id of ['self', 'other']) {
    const record = new PlayerRecord()
    Object.assign(record, { id, x: 0, y: 0, z: 0, spawnTick: 1 })
    state.players.set(id, record)
  }
  const encoder = new Encoder(state)
  const room = new Room<unknown, FrontierState>('life-regression', FrontierState)
  room.serializer.setState(encoder.encodeAll())
  encoder.discardChanges()
  const self = room.state.players.get('self')
  const other = room.state.players.get('other')
  if (!(self && other)) {
    throw new Error('Native schema did not decode players')
  }
  const predict = Predict.get(room, { mode: 'lerp', delay: 100 })
  predict.attachAll('players', REMOTE_POSE)
  const input = room.input({ type: MoveInput, mode: 'reliable' })
  const scratch = { x: self.x, y: self.y, z: self.z }
  const mine = predict.sim({
    input,
    stepMs: 50,
    world: { scratch },
    step: () => undefined,
    adopt: () => Object.assign(scratch, { x: self.x, y: self.y, z: self.z }),
    pose: () => ({ ...scratch }),
    smoothMs: 90,
    snap: 2,
  })
  const resets: string[] = []
  const sync = playerLifetimeSync('self', predict, mine, (id) => resets.push(id))
  sync(room.state.players.values())
  try {
    expect(mine.value('x')).toBe(0)
    expect(predict.value(other, 'x')).toBe(0)
    for (let life = 2; life <= 12; life++) {
      const x = life % 2 ? 0 : 1.5 // Below the teleport threshold: the life marker must reset it.
      for (const record of state.players.values()) {
        Object.assign(record, { x, spawnTick: life })
      }
      room.serializer.patch(encoder.encode())
      encoder.discardChanges()
      sync(room.state.players.values())
      expect(mine.value('x')).toBe(x)
      expect(predict.value(other, 'x')).toBe(x)
      expect(resets.length).toBe((life - 1) * 2)
      sync(room.state.players.values())
      expect(resets.length).toBe((life - 1) * 2)
    }
  } finally {
    predict.dispose()
  }
})
