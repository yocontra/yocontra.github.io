import { expect, test as it } from 'bun:test'
import { touchActions } from '../../src/experiments/out-west/client/touch-actions.ts'
import { createWorld, newPlayer, pairKey } from '../../src/experiments/out-west/ffa/sim/state.ts'

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
  expect(touchActions(world, player)).toEqual({ use: false, call: false, throw: true })
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

it('shows CALL for an eligible invitation through the final accepted tick', () => {
  const { world, player } = fixture()
  const challenger = newPlayer(1, {
    accountId: 'challenger',
    name: 'Opponent',
    level: 1,
    prestige: 0,
    bot: false,
  })
  Object.assign(player, { calledBy: challenger.id, calledUntil: world.tick, carried: 50 })
  expect(touchActions(world, player).call).toBe(false)
  Object.assign(challenger, { alive: true, carried: 50, x: 50, z: 50 })
  world.players[challenger.id] = challenger
  expect(touchActions(world, player).call).toBe(true)
  const pair = pairKey(challenger.id, player.id)
  world.noDuel.add(pair)
  expect(touchActions(world, player).call).toBe(false)
  world.noDuel.delete(pair)
  world.tick++
  expect(touchActions(world, player).call).toBe(false)

  Object.assign(challenger, { x: player.x + 3, z: player.z })
  expect(touchActions(world, player).call).toBe(true)
  player.calloutCooldownUntil = world.tick + 1
  expect(touchActions(world, player).call).toBe(false)
})
