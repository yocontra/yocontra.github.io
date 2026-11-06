import { describe, expect, test as it } from 'bun:test'
import { Group } from 'three'
import { Ragdolls } from '../../../src/experiments/out-west/ffa/scene/ragdoll.ts'

const at = { x: 10, y: 0, z: 10 }
const from = { x: 8, z: 10 }

describe('client death ragdoll', () => {
  it('spawns, falls to the floor and releases on respawn', () => {
    const r = new Ragdolls(new Group(), true, () => 0)
    expect(r.spawn(1, at, from, null)).toBe(true)
    for (let i = 0; i < 180; i++) {
      r.update(1 / 60)
    }
    const slot = (r as unknown as { slots: { active: boolean; points: { y: number }[] }[] })
      .slots[0]
    expect(slot?.active).toBe(true)
    expect(slot?.points.every((p) => p.y >= 0)).toBe(true)
    r.release(1)
    expect(slot?.active).toBe(false)
    r.dispose()
  })

  it('is disabled on the floor tier so the authored Death clip stays', () => {
    const r = new Ragdolls(new Group(), false, () => 0)
    expect(r.spawn(1, at, from, null)).toBe(false)
    r.dispose()
  })

  it('falls back while all three slots are young', () => {
    const r = new Ragdolls(new Group(), true, () => 0)
    expect(r.spawn(1, at, from, null)).toBe(true)
    expect(r.spawn(2, at, from, null)).toBe(true)
    expect(r.spawn(3, at, from, null)).toBe(true)
    expect(r.spawn(4, at, from, null)).toBe(false)
    r.dispose()
  })
})
