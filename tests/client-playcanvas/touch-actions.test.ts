import { expect, test as it } from 'bun:test'
import { touchActions } from '../../src/experiments/out-west/client/touch-actions.ts'
import { createWorld, newPlayer } from '../../src/experiments/out-west/ffa/sim/state.ts'

function fixture() {
  const world = createWorld()
  const player = newPlayer(0, {
    accountId: 'local',
    name: 'Rider',
    level: 1,
    prestige: 0,
    bot: false,
  })
  Object.assign(player, {
    x: 10,
    z: 10,
    alive: true,
    hp: 100,
    calledBy: -1,
    carried: 0,
    dynamite: 0,
  })
  world.players[0] = player
  return { world, player }
}
it('hides unavailable USE, CALL and THROW rather than covering the aiming area', () => {
  const { world, player } = fixture()
  expect(touchActions(world, player)).toEqual({ use: false, call: false, throw: false })
  player.dynamite = 1
  player.calledBy = 1
  expect(touchActions(world, player)).toEqual({ use: false, call: true, throw: true })
})
it('shows bank USE only when carrying money in an actual bank zone', () => {
  const { world, player } = fixture()
  const bank = world.layout.zones.find((zone) => zone.kind === 'bank')
  if (!bank) {
    throw new Error('Missing authored bank')
  }
  Object.assign(player, { x: bank.x, z: bank.z, carried: 50 })
  expect(touchActions(world, player).use).toBe(true)
  player.carried = 0
  expect(touchActions(world, player).use).toBe(false)
})
