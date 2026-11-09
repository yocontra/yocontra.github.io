import { describe, expect, test as it } from 'bun:test'
import { BTN_FIRE, BTN_JUMP } from '../../../src/experiments/out-west/contract/town.ts'
import { TOWN } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import {
  CLIMBS,
  ladderAt,
  ROOF_WALKS,
  roofWalkAt,
} from '../../../src/experiments/out-west/ffa/sim/roofwalks.ts'
import { aimAt, place, run } from './test-helpers.ts'
import { nativeTestWorld } from './testing/native.ts'

function firstWalk() {
  const deck = ROOF_WALKS[0]
  if (!deck) {
    throw new Error('Missing authored saloon deck')
  }
  return deck
}
const walk = firstWalk()

async function onDeck() {
  const world = await nativeTestWorld()
  const player = place(world, walk.x + 2, walk.z + walk.d / 2)
  player.y = walk.height
  player.roof = walk.index
  player.support = walk.height
  run(world, 2)
  return { world, player }
}

describe('roof walks', () => {
  it('uses exactly the authored native deck rectangles and no invisible porch ladders', () => {
    expect(ROOF_WALKS).toHaveLength(4)
    for (const deck of ROOF_WALKS) {
      expect(roofWalkAt(deck.index)).toBe(deck)
      expect(TOWN.catwalks?.[deck.index - 1]).toEqual({
        x: deck.x,
        z: deck.z,
        w: deck.w,
        d: deck.d,
        height: deck.height,
      })
      expect(ladderAt(deck.x + 2.35, deck.z + deck.d - 0.4, 0, 0)).toBeNull()
    }
    expect(CLIMBS.length).toBeGreaterThan(0)
    expect(CLIMBS.every((climb) => climb.walk === null)).toBe(true)
  })

  it('ascends and descends every actual authored staircase without a ladder teleport', async () => {
    for (const building of TOWN.buildings) {
      for (const stair of building.stairs ?? []) {
        const world = await nativeTestWorld()
        const player = place(world, stair.x + stair.w / 2, stair.z + stair.d + 0.5)
        for (let tick = 0; tick < 60 && player.y < stair.toY - 0.1; tick++) {
          run(world, 1, { [player.id]: () => ({ moveZ: -127 }) })
        }
        expect(player.y).toBeGreaterThan(stair.toY - 0.1)
        expect(player.climbTicks).toBe(0)
        for (let tick = 0; tick < 60 && player.y > stair.fromY + 0.1; tick++) {
          run(world, 1, { [player.id]: () => ({ moveZ: 127 }) })
        }
        expect(player.y).toBeLessThan(stair.fromY + 0.1)
      }
    }
  })

  it('physical front railings stop a rider walking straight off the balcony', async () => {
    const { world, player } = await onDeck()
    run(world, 30, { [player.id]: () => ({ moveZ: 127 }) })
    expect(player.y).toBeCloseTo(walk.height, 1)
    expect(player.z).toBeLessThan(walk.z + walk.d)
    expect(player.grounded).toBe(true)
  })

  it('can step from the open balcony end and physically fall to the ground', async () => {
    const { world, player } = await onDeck()
    run(world, 16, { [player.id]: () => ({ moveX: -127 }) })
    expect(player.roof).toBe(0)
    expect(player.y).toBeLessThan(walk.height)
    run(world, 40)
    expect(Math.abs(player.y)).toBeLessThan(0.08)
    expect(player.fallTicks).toBe(0)
  })

  it('hits a rider on the catwalk with a pitched shot', async () => {
    const { world, player } = await onDeck()
    const street = place(world, player.x, walk.z + walk.d + 6)
    run(world, 1, {
      [street.id]: () => ({
        aim: aimAt(street, player),
        pitch: Math.round(
          (Math.atan2(
            player.y + 1.65 - (street.y + 1.62),
            Math.hypot(player.x - street.x, player.z - street.z),
          ) *
            127) /
            (Math.PI / 2),
        ),
        buttons: BTN_FIRE,
      }),
    })
    expect(player.hp).toBeLessThan(100)
  })

  it('respawns return a rider from the deck to a valid street spawn', async () => {
    const { world, player } = await onDeck()
    player.alive = false
    player.respawnTick = 0
    run(world, 1)
    expect(Math.abs(player.y)).toBeLessThan(0.08)
    expect(player.roof).toBe(0)
    // Jumping at the old phantom ladder foot remains a normal native jump.
    player.x = walk.x + 2.35
    player.z = walk.z + walk.d - 0.4
    run(world, 1, { [player.id]: () => ({ buttons: BTN_JUMP }) })
    expect(player.climbTicks).toBe(0)
  })
})
