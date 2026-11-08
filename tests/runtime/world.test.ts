import { beforeAll, describe, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import {
  Buttons,
  type CollisionData,
  neutralInput,
  validInput,
} from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
const floor: CollisionData = {
  version: 'test',
  boxes: [{ center: [0, -0.5, 0], halfExtents: [20, 0.5, 20] }],
  meshes: [],
}
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
describe('engine physics', () => {
  it('capsules settle on native collision and jumping respects support', () => {
    const simulation = createSimulation({ ammo, collision: floor })
    try {
      const player = simulation.addPlayer('a')
      for (let i = 0; i < 60; i++) {
        simulation.step(new Map())
      }
      expect(player.y).toBeCloseTo(0.9, 2)
      expect(player.grounded).toBe(true)
      simulation.step(new Map([['a', { ...neutralInput(), seq: 1, buttons: Buttons.jump }]]))
      expect(player.vy).toBeGreaterThan(5)
      for (let i = 0; i < 5; i++) {
        simulation.step(new Map([['a', { ...neutralInput(), seq: 2, buttons: Buttons.jump }]]))
      }
      expect(player.vy).toBeLessThan(6)
    } finally {
      simulation.dispose()
    }
  })
  it('worlds are isolated, disposal does not invalidate another world, and player caps are enforced', () => {
    const first = createSimulation({ ammo, collision: floor })
    const second = createSimulation({ ammo, collision: floor })
    first.addPlayer('same', [1, 2, 0])
    const player = second.addPlayer('same', [5, 2, 0])
    first.dispose()
    for (let i = 0; i < 40; i++) {
      second.step(new Map())
    }
    expect(player.x).toBeCloseTo(5, 2)
    for (let i = 1; i < 32; i++) {
      second.addPlayer(String(i), [i, 5, 0])
    }
    expect(() => second.addPlayer('overflow')).toThrow('Room full')
    second.dispose()
    second.dispose()
  })
  it('invalid client intent cannot enter the simulation', () => {
    expect(validInput(neutralInput())).toBe(true)
    expect(validInput({ ...neutralInput(), moveX: Number.POSITIVE_INFINITY })).toBe(false)
    expect(validInput({ ...neutralInput(), buttons: 2048 })).toBe(false)
    expect(validInput({ ...neutralInput(), seq: -1 })).toBe(false)
  })
})

describe('Out West abilities use native body collision', () => {
  it('sprints, starts a slide on crouch, preserves foot height and rolls with cooldown', () => {
    const simulation = createSimulation({ ammo, collision: floor })
    try {
      const player = simulation.addPlayer('a')
      for (let i = 0; i < 40; i++) {
        simulation.step(new Map())
      }
      simulation.step(
        new Map([['a', { ...neutralInput(), seq: 1, moveZ: -1, buttons: Buttons.sprint }]]),
      )
      expect(player.motion?.sprinting).toBe(true)
      expect(Math.abs(player.vz)).toBeGreaterThan(7)
      simulation.step(
        new Map([['a', { ...neutralInput(), seq: 2, moveZ: -1, buttons: Buttons.crouch }]]),
      )
      expect(player.motion?.slideTicks).toBeGreaterThan(0)
      for (let i = 0; i < 20; i++) {
        simulation.step(new Map([['a', { ...neutralInput(), buttons: Buttons.crouch }]]))
      }
      expect(player.y).toBeCloseTo(0.9, 1)
      simulation.step(
        new Map([['a', { ...neutralInput(), seq: 3, moveZ: -1, buttons: Buttons.roll }]]),
      )
      expect(player.motion?.rollTicks).toBeGreaterThan(0)
      expect(player.motion?.rollCooldown).toBeGreaterThan(0)
    } finally {
      simulation.dispose()
    }
  })
  it('vaults low cover after probing a clear native landing', () => {
    const simulation = createSimulation({
      ammo,
      collision: {
        ...floor,
        boxes: [...floor.boxes, { center: [0, 0.3, -1], halfExtents: [1, 0.3, 0.25] }],
      },
    })
    try {
      const player = simulation.addPlayer('a', [0, 0.9, 0])
      for (let i = 0; i < 8; i++) {
        simulation.step(new Map())
      }
      simulation.step(
        new Map([['a', { ...neutralInput(), seq: 1, moveZ: -1, buttons: Buttons.jump }]]),
      )
      expect(player.motion?.vaultStep).toBeGreaterThan(0)
      for (let i = 0; i < 20; i++) {
        simulation.step(new Map())
      }
      expect(player.z).toBeLessThan(-1.5)
    } finally {
      simulation.dispose()
    }
  })
})

it('mantles a tall ledge and climbs authored ladders using native kinematic bodies', async () => {
  const { CLIMBS, CLIMB_TICKS } = await import(
    '../../src/experiments/out-west/ffa/sim/roofwalks.ts'
  )
  const simulation = createSimulation({
    ammo,
    collision: {
      ...floor,
      boxes: [...floor.boxes, { center: [0, 0.9, -1], halfExtents: [1, 0.9, 0.5] }],
    },
  })
  try {
    const player = simulation.addPlayer('a', [0, 0.9, 0])
    for (let i = 0; i < 8; i++) {
      simulation.step(new Map())
    }
    simulation.step(new Map([['a', { ...neutralInput(), seq: 1, buttons: Buttons.jump }]]))
    expect(player.motion?.mantleTicks).toBeGreaterThan(0)
    for (let i = 0; i < 20; i++) {
      simulation.step(new Map())
    }
    expect(player.y).toBeGreaterThan(2.5)
  } finally {
    simulation.dispose()
  }
  const climb = CLIMBS[0]
  if (!climb) {
    throw new Error('Missing authored ladder')
  }
  const ladderWorld = createSimulation({
    ammo,
    collision: {
      version: 'ladder',
      boxes: [{ center: [128, -0.5, 128], halfExtents: [256, 0.5, 256] }],
      meshes: [],
    },
  })
  try {
    const player = ladderWorld.addPlayer('ladder', [
      climb.bottomX,
      climb.bottom + 0.9,
      climb.bottomZ,
    ])
    for (let i = 0; i < 4; i++) {
      ladderWorld.step(new Map())
    }
    ladderWorld.step(new Map([['ladder', { ...neutralInput(), buttons: Buttons.interact }]]))
    expect(player.motion?.climbTicks).toBeGreaterThan(0)
    for (let i = 0; i < CLIMB_TICKS - 1; i++) {
      ladderWorld.step(new Map())
    }
    expect(player.y - 0.9).toBeCloseTo(climb.top, 1)
  } finally {
    ladderWorld.dispose()
  }
})
