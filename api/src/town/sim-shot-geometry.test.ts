import { describe, expect, it } from 'bun:test'
import { Vec3 } from 'playcanvas'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../../src/experiments/out-west/contract/town.ts'
import { eyeHeight, fire } from '../../../src/experiments/out-west/ffa/sim/combat.ts'
import { firePickupWeapon } from '../../../src/experiments/out-west/ffa/sim/pickups.ts'
import type { SimEvent } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import type { CollisionData } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { place } from './test-helpers.ts'
import { nativeWorld } from './testing/native.ts'

const floor: CollisionData = {
  version: 'shot-test',
  boxes: [{ center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] }],
  meshes: [],
}
type Shot = Extract<SimEvent, { type: 'shot' }>

async function elevatedShot(weapon: number): Promise<Shot> {
  const w = (await nativeWorld(floor)).world
  const p = place(w, 20, 64)
  p.y = 7
  p.pitch = -63
  p.weapon = weapon
  p.weaponRounds = 5
  if (weapon === 0) {
    fire(w, p, 0, 0)
  } else {
    firePickupWeapon(w, p, 0, 0)
  }
  const shot = w.events.find((e): e is Shot => e.type === 'shot')
  if (!shot) {
    throw new Error('no shot')
  }
  return shot
}

describe('authoritative shot geometry', () => {
  it('records the true sloped revolver endpoint, with no pellet extension', async () => {
    const shot = await elevatedShot(0)
    expect(shot.origin).toEqual({ x: 20, y: 7 + eyeHeight({ crouched: false }), z: 64 })
    expect(shot.pellets).toEqual([])
    expect(shot.end.x).toBeLessThan(shot.origin.x + shot.range * 0.25 - 1)
    expect(shot.end.y).toBeLessThan(0.2)
    expect(shot.end.y).toBeGreaterThan(-0.01)
  })

  it('records the rifle actual impact height rather than the old constant body height', async () => {
    const shot = await elevatedShot(WEAPON_RIFLE)
    expect(shot.end.y).toBeLessThan(0.2)
    expect(shot.y).toBe(Math.round(shot.end.y * 10))
    expect(shot.pellets).toEqual([])
  })

  it('preserves all eight shotgun pellet endpoints without changing shell statistics', async () => {
    const shot = await elevatedShot(WEAPON_SHOTGUN)
    expect(shot.pellets.length).toBe(8)
    expect(shot.pellets.every((p) => p.y < shot.origin.y && p.x > shot.origin.x)).toBe(true)
    expect(shot.pellets).toContainEqual(shot.end)
    expect(new Set(shot.pellets.map((p) => `${p.x},${p.y},${p.z}`)).size).toBeGreaterThan(1)
  })
})

describe('native static ray intersection', () => {
  it('finds ground accurately for shallow and steep rays, with no hit beyond range', async () => {
    const s = await nativeWorld(floor)
    for (const dy of [-0.1, -Math.SQRT1_2, -0.99]) {
      const hit = s.physics.castWorld({
        ox: 20,
        oy: 0.42,
        oz: 64,
        dx: Math.sqrt(1 - dy * dy),
        dy,
        dz: 0,
        maxT: 35,
      })
      expect(hit).toBeCloseTo(-0.42 / dy, 4)
    }
    expect(
      s.physics.castWorld({ ox: 20, oy: 2, oz: 64, dx: 1, dy: -0.01, dz: 0, maxT: 2 }),
    ).toBeNull()
    expect(
      s.physics.castWorld({ ox: 20, oy: 0.001, oz: 64, dx: 0, dy: 1, dz: 0, maxT: 2 }),
    ).toBeNull()
  })
  it('keeps an earlier raised roof and wall ahead of the ground backstop', async () => {
    const s = await nativeWorld({
      ...floor,
      boxes: [
        ...floor.boxes,
        { center: [24.5, 2.15, 64], halfExtents: [1.5, 0.15, 1] },
        { center: [21, 2, 60], halfExtents: [0.1, 2, 1] },
      ],
    })
    const d = Math.sqrt(1.25)
    expect(
      s.physics.castWorld({ ox: 20, oy: 4, oz: 64, dx: 1 / d, dy: -0.5 / d, dz: 0, maxT: 20 }),
    ).toBeLessThan(5)
    expect(
      s.physics.castWorld({ ox: 20, oy: 3, oz: 60, dx: 1 / d, dy: -0.5 / d, dz: 0, maxT: 20 }),
    ).toBeLessThan(2)
  })
  it('returns exact engine face normals for oblique wall and pitched roof contacts', async () => {
    const s = await nativeWorld({
      ...floor,
      boxes: [...floor.boxes, { center: [10.5, 2, 64], halfExtents: [0.5, 2, 5] }],
      meshes: [
        { positions: [20, 3, 60, 30, 8, 60, 30, 8, 70, 20, 3, 70], indices: [0, 2, 1, 0, 3, 2] },
      ],
    })
    const physics = s.physics.app.systems.rigidbody
    if (!physics) {
      throw new Error('Native physics missing')
    }
    const wall = physics.raycastFirst(new Vec3(9, 1.62, 64), new Vec3(14, 1.12, 65.5))
    expect(wall?.point.x).toBeCloseTo(10, 4)
    expect(wall?.normal.x).toBeCloseTo(-1, 4)
    const roof = physics.raycastFirst(new Vec3(24, 9, 64), new Vec3(24, 0, 64))
    expect(roof?.point.y).toBeCloseTo(5, 4)
    expect(roof?.normal.x).toBeCloseTo(-1 / Math.sqrt(5), 4)
    expect(roof?.normal.y).toBeCloseTo(2 / Math.sqrt(5), 4)
  })
})
