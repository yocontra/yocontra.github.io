/** Product movement cases run through the exact native motor used by the room and prediction. */
import { describe, expect, test as it } from 'bun:test'
import {
  BTN_AIM,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_JUMP,
  BTN_ROLL,
  BTN_SPRINT,
} from '../../../src/experiments/out-west/contract/town.ts'
import { inIframes } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import type { CollisionData } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { place, run, runCollect } from './test-helpers.ts'
import { nativeWorld } from './testing/native.ts'

const floor: CollisionData = {
  version: 'movement',
  boxes: [{ center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] }],
  meshes: [],
}
async function fixture(extra: CollisionData['boxes'] = []) {
  const simulation = await nativeWorld({ ...floor, boxes: [...floor.boxes, ...extra] })
  const p = place(simulation.world, 30, 64)
  run(simulation.world, 4)
  return { w: simulation.world, p }
}
describe('native movement', () => {
  it.each([
    [0, 127, 0, 5.5],
    [BTN_SPRINT, 127, 0, 7.6],
    [BTN_CROUCH, 127, 0, 2.9],
    [BTN_AIM, 127, 0, 3.025],
    [BTN_SPRINT, 0, 127, 5.5],
    [BTN_SPRINT | BTN_AIM, 127, 0, 3.025],
  ])('speed for buttons %i and stick %i,%i', async (buttons, moveX, moveZ, speed) => {
    const { w, p } = await fixture()
    const start = { x: p.x, z: p.z }
    run(w, 20, { [p.id]: () => ({ buttons, moveX, moveZ }) })
    expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeCloseTo(speed, 1)
  })
  it('normalizes diagonals and ignores stick noise', async () => {
    const { w, p } = await fixture()
    run(w, 20, { [p.id]: () => ({ moveX: 10, moveZ: -8 }) })
    expect(p.x).toBeCloseTo(30, 3)
    run(w, 20, { [p.id]: () => ({ moveX: 127, moveZ: 127 }) })
    expect(Math.hypot(p.x - 30, p.z - 64)).toBeCloseTo(5.5, 1)
  })
  it('slides along walls and cannot roll through a half metre wall', async () => {
    const { w, p } = await fixture([{ center: [33, 1.5, 64], halfExtents: [0.25, 1.5, 10] }])
    run(w, 40, { [p.id]: () => ({ moveX: 127, moveZ: 40 }) })
    expect(p.x).toBeLessThan(32.4)
    expect(p.z).toBeGreaterThan(65)
    run(w, 7, { [p.id]: (t) => ({ moveX: 127, buttons: t === w.tick ? BTN_ROLL : 0 }) })
    expect(p.x).toBeLessThan(32.4)
  })
  it('rolls four metres with five iframe ticks and a cooldown; stationary roll follows aim', async () => {
    const { w, p } = await fixture()
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_ROLL }) })
    let iframes = inIframes(p) ? 1 : 0
    while (p.rollTicks > 0) {
      run(w, 1)
      iframes += inIframes(p) ? 1 : 0
    }
    expect(p.x - 30).toBeCloseTo(4, 1)
    expect(iframes).toBe(5)
    expect(p.rollCooldown).toBeGreaterThan(0)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_ROLL }) })
    expect(p.rollTicks).toBe(0)
    run(w, 50)
    run(w, 1, { [p.id]: () => ({ buttons: BTN_ROLL, aim: 16_384 }) })
    expect(p.rollDirZ).toBeCloseTo(1, 4)
  })
  it('slides after sprint, covers about 4.4m and cannot restart during cooldown', async () => {
    const { w, p } = await fixture()
    run(w, 4, { [p.id]: () => ({ moveX: 127, buttons: BTN_SPRINT }) })
    const x = p.x
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_CROUCH }) })
    expect(inIframes(p)).toBe(true)
    while (p.slideTicks > 0) {
      run(w, 1)
    }
    expect(p.x - x).toBeGreaterThan(3.8)
    expect(p.x - x).toBeLessThan(5)
    expect(p.slideCooldown).toBeGreaterThan(0)
  })
  it('keeps takeoff momentum while allowing limited air steering', async () => {
    const { w, p } = await fixture()
    run(w, 4, { [p.id]: () => ({ moveX: 127, buttons: BTN_SPRINT }) })
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_SPRINT | BTN_JUMP }) })
    expect(p.grounded).toBe(false)
    const x = p.x
    run(w, 4, { [p.id]: () => ({ moveX: -127 }) })
    expect(p.x).toBeGreaterThan(x + 0.5)
  })
  it('vaults committed cover without rolling or firing mid arc, then lands clear', async () => {
    const { w, p } = await fixture([{ center: [31.2, 0.55, 64], halfExtents: [0.2, 0.55, 1] }])
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_JUMP }) })
    expect(p.vaultStep).toBeGreaterThan(0)
    const shots = runCollect(
      w,
      4,
      { [p.id]: () => ({ moveX: -127, buttons: BTN_ROLL | BTN_FIRE | BTN_JUMP }) },
      'shot',
    )
    expect(p.y).toBeGreaterThan(0.4)
    expect(p.rollTicks).toBe(0)
    expect(shots).toEqual([])
    run(w, 12)
    expect(p.x).toBeGreaterThan(32)
    expect(Math.abs(p.y)).toBeLessThan(0.02)
  })
  it('refuses a tall wall and does not double jump while airborne', async () => {
    const { w, p } = await fixture([{ center: [31.2, 2, 64], halfExtents: [0.2, 2, 1] }])
    run(w, 1, { [p.id]: () => ({ moveX: 127, buttons: BTN_JUMP }) })
    expect(p.vaultStep).toBe(0)
    expect(p.mantleTicks).toBe(0)
    run(w, 1)
    const before = p.vy
    run(w, 1, { [p.id]: () => ({ buttons: BTN_JUMP }) })
    expect(p.vy).toBeLessThan(before)
    run(w, 30, { [p.id]: () => ({ moveX: 127 }) })
    expect(p.x).toBeLessThan(30.7)
  })
})
