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
  FALL_TICKS,
  ROOF_WALKS,
  type RoofWalk,
  roofWalkAt,
} from '../../../src/experiments/out-west/ffa/sim/roofwalks.ts'
import { aimAt, place, run, testWorld } from './test-helpers.ts'

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

  it('climbs a ladder to its deck and back down', () => {
    const w = testWorld()
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
    expect(p.y).toBe(0)
    expect(p.x).toBeCloseTo(walk.ladderX)
    expect(p.z).toBeCloseTo(walk.ladderZ)
  })

  it('walks along the catwalk but cannot step off its edge', () => {
    const w = testWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    run(w, 60, { [p.id]: () => ({ moveX: 127, moveZ: 0 }) })
    expect(p.y).toBeCloseTo(walk.height)
    expect(p.x).toBeGreaterThanOrEqual(walk.x + PLAYER_RADIUS - 0.02)
    expect(p.x).toBeLessThanOrEqual(walk.x + walk.w - PLAYER_RADIUS + 0.02)
    for (let i = 0; i < 12; i++) {
      run(w, 1, { [p.id]: () => ({ moveZ: 127 }) })
    }
    expect(p.z).toBeLessThanOrEqual(walk.z + walk.d - PLAYER_RADIUS + 0.02)
    expect(p.y).toBeCloseTo(walk.height)
  })

  it('steps off the deck, falls, and lands on clear ground', () => {
    const w = testWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    // move away from the ladder so the next jump is a step-off, not a climb down
    run(w, 20, { [p.id]: () => ({ moveX: 127 }) })
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    expect(p.fallTicks).toBeGreaterThan(0)
    expect(p.roof).toBe(0)
    const fromY = p.y
    expect(fromY).toBeGreaterThan(0)
    run(w, FALL_TICKS)
    expect(p.fallTicks).toBe(0)
    expect(p.y).toBe(0)
    expect(p.roof).toBe(0)
    expect(circleBlocked(grid, { x: p.x, z: p.z, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
  })

  it('keeps 2D gunfire working between the street and the catwalk', () => {
    const w = testWorld()
    const walk = firstWalk()
    const roof = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [roof.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    const street = place(w, walk.ladderX + 3, walk.ladderZ + 1.2)
    run(w, 1, {
      [street.id]: () => ({ aim: aimAt(street, roof), buttons: BTN_FIRE }),
    })
    expect(roof.hp).toBeLessThan(100)
    run(w, 20)
    run(w, 1, {
      [roof.id]: () => ({ aim: aimAt(roof, street), buttons: BTN_FIRE }),
    })
    expect(street.hp).toBeLessThan(100)
  })

  it('respawns and deaths return a rider to the street', () => {
    const w = testWorld()
    const walk = firstWalk()
    const p = place(w, walk.ladderX, walk.ladderZ)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    run(w, CLIMB_TICKS)
    expect(p.roof).toBe(walk.index)
    // A showdown still leaves the rider on the deck; a respawn does not.
    p.alive = false
    p.respawnTick = 0
    run(w, 1)
    expect(p.y).toBe(0)
    expect(p.roof).toBe(0)
  })
})
