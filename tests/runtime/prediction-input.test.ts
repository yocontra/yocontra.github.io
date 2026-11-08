import { beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { predictionInput } from '../../src/experiments/out-west/client/player-pose.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { Buttons, neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})

it('dead, showdown and departing riders do not predict walking or jumping; live riders do', () => {
  const simulation = createSimulation({
    ammo,
    collision: {
      version: 'prediction-input',
      boxes: [{ center: [0, -0.5, 0], halfExtents: [20, 0.5, 20] }],
      meshes: [],
    },
  })
  try {
    const body = simulation.addPlayer('self')
    for (let i = 0; i < 40; i++) {
      simulation.step(new Map())
    }
    const intent = {
      ...neutralInput(),
      seq: 9,
      moveZ: -1,
      yaw: 0.3,
      pitch: 0.2,
      buttons: Buttons.jump | Buttons.fire,
      viewTime: 77,
    }
    for (const rider of [
      { alive: false, showdown: -1, lingerUntil: -1 },
      { alive: true, showdown: 0, lingerUntil: -1 },
      { alive: true, showdown: -1, lingerUntil: 100 },
    ]) {
      const before = { x: body.x, y: body.y, z: body.z }
      const command = predictionInput(intent, rider)
      expect([command.seq, command.yaw, command.pitch, command.viewTime]).toEqual([9, 0.3, 0.2, 77])
      for (let tick = 0; tick < 5; tick++) {
        simulation.step(new Map([['self', command]]))
      }
      expect(Math.hypot(body.x - before.x, body.z - before.z)).toBeLessThan(0.001)
      expect(body.y).toBeCloseTo(before.y, 2)
      expect(body.grounded).toBe(true)
    }
    const live = predictionInput(intent, { alive: true, showdown: -1, lingerUntil: -1 })
    expect(live).toBe(intent)
    simulation.step(new Map([['self', live]]))
    expect(body.vy).toBeGreaterThan(5)
    expect(Math.hypot(body.vx, body.vz)).toBeGreaterThan(1)
    expect(intent.buttons).toBe(Buttons.jump | Buttons.fire)
  } finally {
    simulation.dispose()
  }
})
