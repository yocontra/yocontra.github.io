import { describe, expect, test as it } from 'bun:test'
import { BTN_FIRE, BTN_JUMP } from '../../../src/experiments/out-west/contract/town.ts'
import { PLAYER_RADIUS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  buildGrid,
  circleBlocked,
} from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import {
  CLIMB_TICKS,
  ROOF_WALKS,
  type RoofWalk,
  roofWalkAt,
} from '../../../src/experiments/out-west/ffa/sim/roofwalks.ts'
import { aimAt, place, run } from './test-helpers.ts'
import { nativeTestWorld } from './testing/native.ts'

const grid = buildGrid()

function firstWalk(): RoofWalk {
  const w = ROOF_WALKS[0]
  if (!w) {
    throw new Error('roof walks missing')
  }
  return w
}

describe('roof walks', () => {
  it('puts every ladder foot on walkable street and every deck clear of the walls', () => {
    for (const w of ROOF_WALKS) {
      expect(
        circleBlocked(grid, { x: w.ladderX, z: w.ladderZ, r: PLAYER_RADIUS }, BLOCK_MOVE),
      ).toBe(false)
      expect(roofWalkAt(w.index)).toBe(w)
      expect(w.w).toBeGreaterThan(PLAYER_RADIUS * 2)
      expect(w.d).toBeGreaterThan(PLAYER_RADIUS * 2)
    }
  })

  it('climbs a ladder to its deck and back down', async () => {
    const w = await nativeTestWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    expect(p.climbTicks).toBeGreaterThan(0)
    expect(p.climbDir).toBe(1)
    expect(p.roof).toBe(0)
    run(w, CLIMB_TICKS)
    expect(p.climbTicks).toBe(0)
    expect(p.roof).toBe(walk.index)
    expect(p.y).toBeCloseTo(walk.height)
    expect(p.x).toBeCloseTo(walk.ladderX)
    expect(p.z).toBeCloseTo(walk.ladderZ)

    // A second jump at the same spot takes the ladder down.
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    expect(p.climbTicks).toBeGreaterThan(0)
    expect(p.climbDir).toBe(-1)
    run(w, CLIMB_TICKS)
    expect(p.roof).toBe(0)
    expect(Math.abs(p.y)).toBeLessThan(0.08)
    expect(p.x).toBeCloseTo(walk.ladderX)
    expect(p.z).toBeCloseTo(walk.ladderZ)
  })

  it('walks along the catwalk and falls off its edge', async () => {
    const w = await nativeTestWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    run(w, 40, { [p.id]: () => ({ moveX: 0, moveZ: 127 }) })
    expect(p.roof).toBe(0)
    expect(p.y).toBeLessThan(walk.height)
    run(w, 40)
    expect(Math.abs(p.y)).toBeLessThan(0.08)
  })

  it('steps off the deck, falls, and lands on clear ground', async () => {
    const w = await nativeTestWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    // walk off the catwalk's open edge: the surface model drops the feet into a real fall
    run(w, 8, { [p.id]: () => ({ moveZ: 127 }) })
    expect(p.roof).toBe(0)
    expect(p.fallTicks).toBeGreaterThan(0)
    const fromY = p.y
    expect(fromY).toBeGreaterThan(0)
    run(w, 40)
    expect(p.fallTicks).toBe(0)
    expect(Math.abs(p.y)).toBeLessThan(0.08)
    expect(p.roof).toBe(0)
  })

  it('hits a rider on the catwalk with a pitched shot', async () => {
    const w = await nativeTestWorld()
    const walk = firstWalk()
    const roof = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [roof.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    const street = place(w, walk.ladderX + 3, walk.ladderZ + 1.2)
    run(w, 1, {
      [street.id]: () => ({ aim: aimAt(street, roof), pitch: 65, buttons: BTN_FIRE }),
    })
    expect(roof.hp).toBeLessThan(100)
  })

  it('respawns and deaths return a rider to the street', async () => {
    const w = await nativeTestWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    expect(p.roof).toBe(walk.index)
    // A showdown still leaves the rider on the deck; a respawn does not.
    p.alive = false
    p.respawnTick = 0
    run(w, 1)
    expect(Math.abs(p.y)).toBeLessThan(0.08)
    expect(p.roof).toBe(0)
  })
})
