import { describe, expect, it } from 'bun:test'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../../src/experiments/out-west/contract/town.ts'
import { eyeHeight, fire } from '../../../src/experiments/out-west/ffa/sim/combat.ts'
import { buildGrid, TOWN } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { firePickupWeapon } from '../../../src/experiments/out-west/ffa/sim/pickups.ts'
import { impactNormal, rayWorld } from '../../../src/experiments/out-west/ffa/sim/surfaces.ts'
import type { SimEvent } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { place, testWorld } from './test-helpers.ts'

type Shot = Extract<SimEvent, { type: 'shot' }>

function elevatedShot(weapon: number): Shot {
  const w = testWorld()
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
  it('records the true sloped revolver endpoint, with no pellet extension', () => {
    const shot = elevatedShot(0)
    expect(shot.origin).toEqual({ x: 20, y: 7 + eyeHeight({ crouched: false }), z: 64 })
    expect(shot.pellets).toEqual([])
    expect(shot.end.x).toBeLessThan(shot.origin.x + shot.range * 0.25 - 1)
    expect(shot.end.y).toBeLessThan(0.2)
    expect(shot.end.y).toBeGreaterThan(-0.01)
  })

  it('records the rifle actual impact height rather than the old constant body height', () => {
    const shot = elevatedShot(WEAPON_RIFLE)
    expect(shot.end.y).toBeLessThan(0.2)
    expect(shot.y).toBe(Math.round(shot.end.y * 10))
    expect(shot.pellets).toEqual([])
  })

  it('preserves all eight shotgun pellet endpoints without changing shell statistics', () => {
    const shot = elevatedShot(WEAPON_SHOTGUN)
    expect(shot.pellets.length).toBe(8)
    expect(shot.pellets.every((p) => p.y < shot.origin.y && p.x > shot.origin.x)).toBe(true)
    expect(shot.pellets).toContainEqual(shot.end)
    expect(new Set(shot.pellets.map((p) => `${p.x},${p.y},${p.z}`)).size).toBeGreaterThan(1)
  })
})

describe('ground ray intersection', () => {
  const openGrid = () => buildGrid({ ...TOWN, buildings: [], cover: [] })

  it('finds the exact plane at shallow and steep angles that step over the old ground band', () => {
    for (const dy of [-0.1, -Math.SQRT1_2, -0.99]) {
      const dx = Math.sqrt(1 - dy * dy)
      const hit = rayWorld(openGrid(), 20, 0.42, 64, dx, dy, 0, 35)
      expect(hit?.y).toBe(0)
      expect(hit?.dist).toBeCloseTo(-0.42 / dy, 6)
    }
  })

  it('keeps an earlier raised roof and wall ahead of the ground backstop', () => {
    const roof = openGrid()
    roof.overheads.push({ x: 23, z: 63, w: 3, d: 2, bottom: 2, top: 2.3, kind: 'overhead' })
    const d = Math.sqrt(1.25)
    const roofHit = rayWorld(roof, 20, 4, 64, 1 / d, -0.5 / d, 0, 20)
    expect(roofHit?.dist ?? 20).toBeLessThan(5)
    const wall = openGrid()
    const col = Math.floor(21 / wall.cell)
    const row = Math.floor(64 / wall.cell)
    wall.tops[row * wall.n + col] = 4
    expect(rayWorld(wall, 20, 3, 64, 1 / d, -0.5 / d, 0, 20)?.dist ?? 20).toBeLessThan(2)
  })

  it('handles origins on or below ground without blocking rays that leave the plane upward', () => {
    expect(rayWorld(openGrid(), 20, 0, 64, 0, -1, 0, 20)?.dist).toBe(0)
    expect(rayWorld(openGrid(), 20, -0.1, 64, 0, 1, 0, 20)?.dist).toBe(0)
    expect(rayWorld(openGrid(), 20, 0, 64, 0, 1, 0, 2)).toBeNull()
    expect(rayWorld(openGrid(), 20, 2, 64, 1, -0.01, 0, 2)).toBeNull()
  })
})

describe('flush wall and ground contacts', () => {
  it('refines an oblique hit to the wall and returns a matching distance, point and face normal', () => {
    const grid = buildGrid({ ...TOWN, buildings: [], cover: [] })
    for (let row = 124; row < 134; row++) {
      grid.tops[row * grid.n + 20] = 4
    }
    const norm = Math.hypot(1, 0.1, 0.3)
    const direction = { x: 1 / norm, y: -0.1 / norm, z: 0.3 / norm }
    const hit = rayWorld(grid, 9, 1.62, 64, direction.x, direction.y, direction.z, 5)
    expect(hit?.x ?? 0).toBeCloseTo(10, 2)
    expect(hit?.x).toBeCloseTo(9 + direction.x * (hit?.dist ?? 0), 6)
    expect(hit?.y).toBeCloseTo(1.62 + direction.y * (hit?.dist ?? 0), 6)
    const normal = impactNormal(grid, hit ?? { x: 0, y: 0, z: 0 }, direction)
    expect(normal).toEqual({ x: -1, y: 0, z: 0 })
    expect(impactNormal(grid, { x: 5, y: 0, z: 64 }, direction)).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('uses a pitched roof surface normal rather than the incoming ray', () => {
    const grid = buildGrid({ ...TOWN, buildings: [], cover: [] })
    grid.roofs.push({
      x: 10,
      z: 60,
      w: 10,
      d: 10,
      bottom: 3,
      top: 8,
      kind: 'roof',
      heightAt: (x) => 3 + (x - 10) * 0.5,
    })
    const n = impactNormal(grid, { x: 14, y: 5, z: 64 }, { x: 0, y: -1, z: 0 })
    expect(n.x).toBeCloseTo(-1 / Math.sqrt(5), 6)
    expect(n.y).toBeCloseTo(2 / Math.sqrt(5), 6)
    expect(n.z).toBeCloseTo(0, 6)
  })
})
