import { beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { killPlayer } from '../../src/experiments/out-west/ffa/sim/death.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { addPlayer } from '../../src/experiments/out-west/ffa/sim/world.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { createFrontierSimulation } from '../../src/experiments/out-west/runtime/frontier.ts'
import { Buttons, type CollisionData } from '../../src/experiments/out-west/runtime/protocol.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
const floor: CollisionData = {
  version: 'respawn-probe',
  boxes: [{ center: [72, -0.5, 72], halfExtents: [100, 0.5, 100] }],
  meshes: [],
}
function fixture() {
  const game = createFrontierSimulation({
    ammo,
    collision: floor,
    layout: { ...TOWN, spawns: [{ x: 72, z: 66, interior: false }] },
    seed: 1,
  })
  const id = addPlayer(game.world, {
    accountId: 'respawn',
    name: 'Rider',
    level: 1,
    prestige: 0,
    bot: false,
  })
  const player = game.world.players[id]
  if (!player) {
    throw new Error('Missing rider')
  }
  for (let i = 0; i < 20; i++) {
    game.step([])
  }
  return { game, player, id }
}
it('a natural respawn adopts its exact native pose even within two metres of the previous body', () => {
  const { game, player, id } = fixture()
  try {
    player.x = 69
    game.step([])
    game.step([
      { seq: 1, moveX: 127, moveZ: 0, aim: 0, buttons: Buttons.roll, viewTime: game.world.tick },
    ])
    killPlayer(game.world, player, 255, {})
    const deathAt = game.world.tick
    while (!player.alive) {
      game.step([])
    }
    expect(game.world.tick - deathAt).toBeGreaterThanOrEqual(60)
    expect(player.x).toBe(72)
    game.step([])
    expect(player.x).toBeCloseTo(72, 4)
    expect(game.physics.players.get(String(id))?.x).toBeCloseTo(72, 4)
  } finally {
    game.dispose()
  }
})
it('a new spawn generation clears nearby committed native movement and velocity', () => {
  const { game, player, id } = fixture()
  try {
    game.step([
      { seq: 1, moveX: 127, moveZ: 0, aim: 0, buttons: Buttons.roll, viewTime: game.world.tick },
    ])
    expect(player.rollTicks).toBeGreaterThan(0)
    killPlayer(game.world, player, 255, {})
    player.respawnTick = game.world.tick
    game.step([])
    game.step([])
    const body = game.physics.players.get(String(id))
    expect(player.rollTicks).toBe(0)
    expect(player.slideTicks).toBe(0)
    expect(player.mantleTicks).toBe(0)
    expect(player.x).toBeCloseTo(72, 4)
    expect(body?.motion?.rollTicks).toBe(0)
    expect(body?.vx).toBeCloseTo(0, 3)
    expect(body?.vz).toBeCloseTo(0, 3)
  } finally {
    game.dispose()
  }
})
