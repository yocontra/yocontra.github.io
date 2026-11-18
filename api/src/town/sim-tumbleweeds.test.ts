import { expect, it } from 'bun:test'
import {
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../../src/experiments/out-west/contract/town.ts'
import {
  KICK_LIFETIME,
  MAX_KICK_OFFSET,
  pushTumbleweed,
  TUMBLEWEED_PERIOD,
  TUMBLEWEED_ROUTES,
  tumbleweedCenter,
  tumbleweedOffset,
} from '../../../src/experiments/out-west/contract/tumbleweed-motion.ts'
import { fire, shotRay } from '../../../src/experiments/out-west/ffa/sim/combat.ts'
import { TICK_HZ } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { firePickupWeapon } from '../../../src/experiments/out-west/ffa/sim/pickups.ts'
import type { World } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import { strikeTumbleweeds } from '../../../src/experiments/out-west/ffa/sim/tumbleweed-hits.ts'
import { step } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import type { CollisionData } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { place } from './test-helpers.ts'
import { nativeWorld } from './testing/native.ts'

const ground = { center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] } as const
function fixture(blocked: boolean): CollisionData {
  return {
    version: 'tumbleweed-contact-test',
    boxes: [
      ground,
      ...(blocked ? [{ center: [16, 0.8, 54], halfExtents: [0.2, 0.8, 1.5] } as const] : []),
    ],
    meshes: [],
  }
}

function shootAtFirstWeed(world: World, weapon: number) {
  const target = tumbleweedCenter(TUMBLEWEED_ROUTES[0], 0)
  const player = place(world, target.x - 3, target.z)
  player.weapon = weapon
  player.weaponRounds = 4
  player.crouched = true
  player.ads = true
  const eye = shotRay(player, 0).oy
  player.pitch = Math.round((Math.atan2(target.y - eye, 3) * 127) / (Math.PI / 2))
  world.tick = 1
  if (weapon === WEAPON_REVOLVER) {
    fire(world, player, 0, 0)
  } else {
    firePickupWeapon(world, player, 0, 0)
  }
}

for (const weapon of [WEAPON_REVOLVER, WEAPON_RIFLE, WEAPON_SHOTGUN]) {
  it(`weapon ${weapon} pushes an open weed through its accepted native shot segments`, async () => {
    const { world } = await nativeWorld(fixture(false))
    shootAtFirstWeed(world, weapon)
    expect(world.tumbleweeds[0]?.vx).toBeGreaterThan(1)
    expect(world.tumbleweeds.slice(1)).toEqual([null, null])
    expect(tumbleweedOffset(world.tumbleweeds[0], 11).x).toBeGreaterThan(0.35)
    expect(world.events.filter((event) => event.type === 'shot')).toHaveLength(1)
    for (let i = 0; i < KICK_LIFETIME; i++) {
      step(world, [])
    }
    expect(world.tumbleweeds).toEqual([null, null, null])
  })
}

it('opaque native cover stops a weed strike while open rays reach the same location', async () => {
  const { world } = await nativeWorld(fixture(true))
  shootAtFirstWeed(world, WEAPON_RIFLE)
  expect(world.tumbleweeds).toEqual([null, null, null])
})

it('several pellets use one pre-shell position and repeat impulses stay bounded', async () => {
  const { world } = await nativeWorld(fixture(false))
  const center = tumbleweedCenter(TUMBLEWEED_ROUTES[0], 0)
  const ray = { ox: center.x - 2, oy: center.y, oz: center.z, dx: 1, dy: 0, dz: 0, maxT: 8 }
  strikeTumbleweeds(
    world,
    Array.from({ length: 8 }, () => ({ ray, range: 2.1 })),
    0,
  )
  expect(world.tumbleweeds[0]?.vx).toBeCloseTo(TUMBLEWEED_ROUTES[0].kickLimit * 2 * Math.E)
  let kick = world.tumbleweeds[0] ?? null
  for (let tick = 0; tick < 100; tick++) {
    const before = tumbleweedOffset(kick, tick)
    kick = pushTumbleweed(kick, tick, { x: 3.5, z: 1.5 })
    const after = tumbleweedOffset(kick, tick)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.z).toBeCloseTo(before.z)
    const upcoming = tumbleweedOffset(kick, tick + 10)
    expect(Math.hypot(upcoming.x, upcoming.z)).toBeLessThanOrEqual(MAX_KICK_OFFSET)
  }
  expect(tumbleweedOffset(kick, 100 + KICK_LIFETIME).x).toBe(0)
})

it('the authored routes keep the full kick envelope clear of real Frontier cover', async () => {
  const { world } = await nativeWorld()
  const cast = world.castWorld
  if (!cast) {
    throw new Error('Missing native contact test')
  }
  for (const route of TUMBLEWEED_ROUTES) {
    let obstructed = false
    for (let tick = 0; tick < TUMBLEWEED_PERIOD * TICK_HZ; tick += 4) {
      const center = tumbleweedCenter(route, tick)
      for (let sample = 0; sample < 16; sample++) {
        const angle = (sample * Math.PI) / 8
        obstructed ||=
          cast({
            ox: center.x,
            oy: center.y,
            oz: center.z,
            dx: Math.cos(angle),
            dy: 0,
            dz: Math.sin(angle),
            maxT: route.radius + route.kickLimit,
          }) !== null
      }
    }
    expect(obstructed).toBe(false)
  }
})
