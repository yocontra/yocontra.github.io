import { describe, expect, test as it } from 'bun:test'
import {
  impactMaterial,
  stepSurface,
} from '../../src/experiments/out-west/client/audio-surfaces.ts'
import { STEP_SOUND, stepRate } from '../../src/experiments/out-west/client/frontier-sounds.ts'
import { spaceAt } from '../../src/experiments/out-west/client/frontier-space.ts'
import {
  CROUCH_SPEED,
  RUN_SPEED,
  SPRINT_SPEED,
} from '../../src/experiments/out-west/ffa/sim/constants.ts'
import { buildGrid, TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

const grid = buildGrid()
const creek = { x: 30, z: 1.5 }
const bridge = { x: TOWN.creek.bridge.x + 2, z: creek.z }
const kind = (k: string) => {
  const b = TOWN.buildings.find((building) => building.kind === k)
  if (!b) {
    throw new Error(`no ${k} in the town`)
  }
  return b
}

describe('Frontier bullet strikes', () => {
  it('hear the material that was hit', () => {
    const bank = kind('bank')
    expect(impactMaterial({ x: bank.x, y: 1.2, z: bank.z + bank.d / 2 }, grid)).toBe('stone')
    const saloon = kind('saloon')
    expect(impactMaterial({ x: saloon.x, y: 1.2, z: saloon.z + saloon.d / 2 }, grid)).toBe('wood')
    expect(impactMaterial({ x: 40, y: 0, z: 10 }, grid)).toBe('dirt')
    expect(impactMaterial({ x: creek.x, y: 0, z: creek.z }, grid)).toBe('water')
    expect(impactMaterial({ x: bridge.x, y: 0, z: bridge.z }, grid)).toBe('wood')
    expect(impactMaterial({ x: 40, y: 6, z: 10 }, grid)).toBeNull()
  })
  it('hear each cover prop as what it is made of', () => {
    const sample = (k: string) => {
      const c = TOWN.cover.find((cover) => cover.kind === k)
      return c
        ? impactMaterial({ x: c.x + c.w / 2, y: (c.y0 ?? 0) + 0.5, z: c.z }, grid)
        : undefined
    }
    expect(sample('boxcar')).toBe('metal')
    expect(sample('hay')).toBe('soft')
  })
  it('leave window glass to the shatter', () => {
    const pane = grid.glass[0]
    if (!pane) {
      throw new Error('the town has no glass')
    }
    const along = (pane.a0 + pane.a1) / 2
    const [x, z] = pane.axis === 0 ? [pane.at, along] : [along, pane.at]
    expect(impactMaterial({ x, y: (pane.y0 + pane.y1) / 2, z }, grid)).toBe('glass')
  })
})

describe('Frontier footsteps', () => {
  it('follow the surface underfoot', () => {
    expect(STEP_SOUND[stepSurface(40, 0, 10)]).toBe('stepDirt')
    expect(STEP_SOUND[stepSurface(creek.x, 0, creek.z)]).toBe('stepWater')
    expect(STEP_SOUND[stepSurface(bridge.x, 0, bridge.z)]).toBe('stepWood')
    const barn = kind('barn')
    expect(stepSurface(barn.x + barn.w / 2, 0, barn.z + barn.d / 2)).toBe('straw')
    const jail = kind('jail')
    expect(stepSurface(jail.x + jail.w / 2, 0, jail.z + jail.d / 2)).toBe('stone')
  })
  it('quicken with the gait at a human cadence', () => {
    const crouch = 1 / stepRate(CROUCH_SPEED)
    const run = 1 / stepRate(RUN_SPEED)
    const sprint = 1 / stepRate(SPRINT_SPEED)
    expect(crouch).toBeGreaterThan(run)
    expect(run).toBeGreaterThan(sprint)
    expect(sprint).toBeGreaterThan(0.25)
    expect(crouch).toBeLessThan(0.6)
  })
})

describe('Frontier acoustic spaces', () => {
  it('tell an interior, a street and the open desert apart', () => {
    const saloon = kind('saloon')
    expect(spaceAt({ x: saloon.x + saloon.w / 2, y: 0, z: saloon.z + saloon.d / 2 }).kind).toBe(
      'interior',
    )
    expect(spaceAt({ x: -40, y: 0, z: -40 }).kind).toBe('open')
    const street = TOWN.buildings.some(
      (b) => spaceAt({ x: b.x + b.w / 2, y: 0, z: b.z + b.d + 4 }).kind === 'street',
    )
    expect(street).toBe(true)
  })
})
