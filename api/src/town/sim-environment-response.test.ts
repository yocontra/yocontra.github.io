import { describe, expect, it } from 'bun:test'
import { Vec3 } from 'playcanvas'
import {
  PROP_HEALTH,
  propAtHit,
} from '../../../src/experiments/out-west/content/environment-props.ts'
import {
  SHOT_HIT,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../../src/experiments/out-west/contract/town.ts'
import { fire } from '../../../src/experiments/out-west/ffa/sim/combat.ts'
import { applyPropStrikes } from '../../../src/experiments/out-west/ffa/sim/environment-response.ts'
import { firePickupWeapon } from '../../../src/experiments/out-west/ffa/sim/pickups.ts'
import { recordHistory, type World } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { Player } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { historyFlags } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { COLLISION } from '../../../src/experiments/out-west/runtime/collision.ts'
import type { CollisionData } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { place } from './test-helpers.ts'
import { nativeWorld } from './testing/native.ts'

const collision: CollisionData = {
  version: 'barrel-test',
  boxes: [
    { center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] },
    ...COLLISION.boxes.filter((box) => ['cover:16', 'cover:36'].includes(box.id ?? '')),
  ],
  meshes: [],
}
async function fixture() {
  const simulation = await nativeWorld(collision)
  const shooter = place(simulation.world, 27, 66.25)
  shooter.crouched = true
  shooter.ads = true
  shooter.pitch = -10
  const target = place(simulation.world, 29.8, 66.25)
  return { ...simulation, shooter, target }
}
function shoot(w: World, p: Player, weapon = 0) {
  p.fireCooldownMs = 0
  p.weapon = weapon
  p.weaponRounds = 4
  recordHistory(w, (player) => historyFlags(w, player))
  w.tick++
  if (weapon === 0) {
    fire(w, p, 0, w.tick - 1)
  } else {
    firePickupWeapon(w, p, 0, w.tick - 1)
  }
  const shot = w.events.findLast((event) => event.type === 'shot')
  if (shot?.type !== 'shot') {
    throw new Error('Missing confirmed shot')
  }
  return shot
}

describe('accepted native barrel contacts', () => {
  it('stops the breaking round, removes native cover and allows the next round through', async () => {
    const { world, physics, shooter, target } = await fixture()
    const intactGrid = world.grid
    expect([...world.props]).toEqual(new Array(8).fill(PROP_HEALTH))
    const first = shoot(world, shooter)
    expect(first.flags & SHOT_HIT).toBe(0)
    expect([...world.props]).toEqual([34, ...new Array(7).fill(PROP_HEALTH)])
    expect(target.hp).toBe(100)
    expect(world.grid).toBe(intactGrid)
    shoot(world, shooter)
    expect([...world.props]).toEqual([0, ...new Array(7).fill(PROP_HEALTH)])
    expect(world.events.filter((event) => event.type === 'prop_break')).toHaveLength(1)
    expect(target.hp).toBe(100)
    expect(world.grid).not.toBe(intactGrid)
    expect(world.layout.cover).toHaveLength(intactGrid.layout?.cover.length ?? 0)
    expect(world.grid.layout?.cover).not.toContain(world.layout.cover[16])
    expect(world.props.slice(4)).toEqual(new Uint8Array(4).fill(PROP_HEALTH))
    expect(
      physics.castWorldHit({ ox: 27, oy: 0.5, oz: 66.25, dx: 1, dy: 0, dz: 0, maxT: 1.45 }),
    ).toBeNull()
    expect(
      physics.app.systems.rigidbody?.raycastFirst(
        new Vec3(27, 0.5, 66.25),
        new Vec3(28.4, 0.5, 66.25),
      ),
    ).toBeNull()
    shoot(world, shooter)
    expect(world.props[2]).toBe(34)
    shoot(world, shooter)
    expect(world.props[2]).toBe(0)
    const last = shoot(world, shooter)
    expect(last.target).toBe(target.id)
    expect(target.hp).toBe(66)
    expect(shooter.ammo).toBe(1)
    expect(shooter.stats.shots).toBe(5)
    expect(shooter.stats.hits).toBe(1)
    expect(shooter.fireCooldownMs).toBe(280)
    expect(world.events.filter((event) => event.type === 'prop_break')).toHaveLength(2)
  })

  it('uses the nearest player hit and actual rifle damage, without damaging cover behind a rider', async () => {
    const { world, shooter, target } = await fixture()
    target.x = 27.7
    shoot(world, shooter, WEAPON_RIFLE)
    expect([...world.props]).toEqual(new Array(8).fill(PROP_HEALTH))
    expect(target.hp).toBe(40)
    target.x = 29.8
    shoot(world, shooter, WEAPON_RIFLE)
    expect(world.props[0]).toBe(8)
    expect(world.events.filter((event) => event.type === 'prop_break')).toHaveLength(0)
    shoot(world, shooter, WEAPON_RIFLE)
    expect(world.props[0]).toBe(0)
    expect(target.hp).toBe(40)
    expect(shooter.weaponRounds).toBe(3)
    expect(shooter.fireCooldownMs).toBe(900)
  })

  it('resolves all eight shotgun pellets against the pre-shell collider before breaking it', async () => {
    const { world, shooter, target } = await fixture()
    const shot = shoot(world, shooter, WEAPON_SHOTGUN)
    expect(shot.pellets).toHaveLength(8)
    expect(shot.pellets.every((point) => point.x < 29.01)).toBe(true)
    expect(shot.flags & SHOT_HIT).toBe(0)
    expect(world.props[0]).toBe(0)
    expect(target.hp).toBe(100)
    expect(shooter.stats.hits).toBe(0)
    expect(shooter.stats.shots).toBe(1)
    expect(shooter.weaponRounds).toBe(3)
    expect(world.events.filter((event) => event.type === 'prop_break')).toHaveLength(1)
  })

  it('the network recipe uses a clear actual-town capsule position instead of standing inside the adjacent anvil', async () => {
    const simulation = await nativeWorld(COLLISION)
    const shooter = place(simulation.world, 26, 66.25)
    const target = place(simulation.world, 29.8, 66.25)
    for (let i = 0; i < 15; i++) {
      simulation.step([
        {
          seq: i + 1,
          moveX: 0,
          moveZ: 0,
          aim: 0,
          pitch: -10,
          buttons: 1026,
          viewTime: simulation.world.tick,
        },
        null,
      ])
    }
    expect(shooter.x).toBeCloseTo(26, 4)
    expect(shooter.z).toBeCloseTo(66.25, 4)
    const shot = shoot(simulation.world, shooter)
    expect(shot.end.z).toBeLessThan(66.5)
    expect([...simulation.world.props]).toEqual([34, 68, 68, 68, 68, 68, 68, 68])
    expect(target.hp).toBe(100)
  })

  it('an oblique actual native box contact remains owned even when Bullet returns a point before the nominal face', async () => {
    const simulation = await nativeWorld(COLLISION)
    // Captured from the real SDK/Worker shot, not an analytic ray/box intersection oracle.
    const ray = {
      ox: 26,
      oy: 1.045_945_448_875_427_2,
      oz: 66.25,
      dx: 0.992_659_603_862_66,
      dy: -0.120_869_967_592_318_13,
      dz: 0.004_166_748_547_614_295,
      maxT: 22,
    }
    const hit = simulation.physics.castWorldHit(ray)
    if (!hit) {
      throw new Error('Missing actual native contact')
    }
    expect(hit.collider.id).toBe('cover:16')
    expect(hit.point.x).toBeLessThan(27.999)
    expect(propAtHit(hit)).toBe(0)
    applyPropStrikes(simulation.world, [{ hit, ray, damage: 34 }])
    expect([...simulation.world.props]).toEqual([34, 68, 68, 68, 68, 68, 68, 68])
  })

  it('keeps other rooms intact and an off-target shot cannot damage either barrel', async () => {
    const first = await fixture()
    const second = await fixture()
    first.shooter.z = 70
    shoot(first.world, first.shooter)
    expect([...first.world.props]).toEqual(new Array(8).fill(PROP_HEALTH))
    first.shooter.z = 66.25
    shoot(first.world, first.shooter)
    shoot(first.world, first.shooter)
    expect(first.world.props[0]).toBe(0)
    expect([...second.world.props]).toEqual(new Array(8).fill(PROP_HEALTH))
    expect(
      second.physics.castWorldHit({ ox: 27, oy: 0.5, oz: 66.25, dx: 1, dy: 0, dz: 0, maxT: 1.45 })
        ?.collider.id,
    ).toBe('cover:16')
  })
})
