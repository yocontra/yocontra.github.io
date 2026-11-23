import { expect, test as it } from 'bun:test'
import { file } from 'bun'
import { initializeAmmo } from 'colyseus-cloudflare/ammo'
import { WEAPON_REVOLVER, WEAPON_RIFLE } from '../../src/experiments/out-west/contract/town.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { updatePickups } from '../../src/experiments/out-west/ffa/sim/pickups.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { addPlayer } from '../../src/experiments/out-west/ffa/sim/world.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'
import { COLLISION } from '../../src/experiments/out-west/runtime/collision.ts'
import { neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

it('walks from the street to the belfry and claims its rifle only upstairs', async () => {
  const rifle = TOWN.pickups.find((spot) => spot.id === 'rifle_tower')
  if (!rifle || rifle.y === undefined) {
    throw new Error('Missing elevated belfry pickup')
  }
  const ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
  const sim = createSimulation({ ammo, collision: COLLISION })
  try {
    const climber = sim.addPlayer('climber')
    sim.adopt('climber', {
      ...climber,
      x: 80.57,
      y: 0.94,
      z: 29.6,
      vx: 0,
      vy: 0,
      vz: 0,
      grounded: false,
      lastButtons: 0,
      motion: newMotion(80.57, 0.04, 29.6),
    })
    for (let tick = 0; tick < 15; tick++) {
      sim.step(new Map())
    }
    const route = [
      [80.57, 27.15, 0.03],
      [80.57, 22.95, 2.65],
      [83.42, 22.95, 2.65],
      [83.42, 27.05, 5.3],
      [80.57, 27.05, 5.3],
      [80.57, 22.95, 7.95],
      [83.42, 22.95, 7.95],
      [83.42, 27.05, 10.6],
      [rifle.x, rifle.z, rifle.y],
    ] as const
    for (const [x, z, feet] of route) {
      for (let tick = 0; tick < 160; tick++) {
        const dx = x - climber.x
        const dz = z - climber.z
        const distance = Math.hypot(dx, dz)
        if (distance < 0.14) {
          break
        }
        const stride = Math.min(1, distance * 3) / distance
        sim.step(
          new Map([['climber', { ...neutralInput(), moveX: dx * stride, moveZ: dz * stride }]]),
        )
      }
      expect(Math.hypot(x - climber.x, z - climber.z)).toBeLessThan(0.22)
      expect(Math.abs(feet - (climber.y - 0.9))).toBeLessThan(0.26)
    }

    const town = createWorld({ layout: TOWN })
    const slot = addPlayer(town, {
      accountId: 'climber',
      name: 'Climber',
      level: 1,
      prestige: 0,
      bot: false,
    })
    const rider = town.players[slot]
    if (!rider) {
      throw new Error('Missing belfry player')
    }
    Object.assign(rider, { x: climber.x, y: 0, z: climber.z })
    updatePickups(town)
    expect(rider.weapon).toBe(WEAPON_REVOLVER)
    rider.y = climber.y - 0.9
    updatePickups(town)
    expect(rider.weapon).toBe(WEAPON_RIFLE)
  } finally {
    sim.dispose()
  }
})
