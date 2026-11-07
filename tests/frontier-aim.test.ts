import { describe, expect, it } from 'bun:test'
import { Vector3 } from 'three'
import { place, testWorld } from '../api/src/town/test-helpers.ts'
import { EF_ALIVE, STANCE_CROUCH } from '../src/experiments/out-west/contract/town.ts'
import {
  type AimResult,
  predictShot,
  resolveAim,
} from '../src/experiments/out-west/ffa/client/aim.ts'
import type { RemoteView } from '../src/experiments/out-west/ffa/client/interp.ts'
import { Writer } from '../src/experiments/out-west/ffa/sim/bytes.ts'
import { decodeInput, encodeInput } from '../src/experiments/out-west/ffa/sim/codec.ts'
import { shotRay, traceTargets } from '../src/experiments/out-west/ffa/sim/combat.ts'
import { InputBatcher, quantizePitch } from '../src/experiments/out-west/ffa/sim/input.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { HIST_ALIVE, recordHistory } from '../src/experiments/out-west/ffa/sim/state.ts'

const grid = buildGrid({ ...TOWN, buildings: [], cover: [] })
const result = (): AimResult => ({ yaw: 0, pitch: 0, range: 0, target: -1, point: new Vector3() })
const rider = (id: number, x: number, y: number, z: number): RemoteView => ({
  id,
  x,
  y,
  z,
  stance: 0,
  aim: 0,
  pitch: 0,
  hp: 100,
  flags: EF_ALIVE,
  anim: 0,
  carry: 0,
  vx: 0,
  vz: 0,
  ready: true,
})

describe('Frontier crosshair geometry', () => {
  it('rounds at each signed pitch unit and clamps only at the wire limits', () => {
    for (const [input, expected] of [
      [1.49, 1],
      [1.5, 2],
      [2, 2],
      [-1.49, -1],
      [-1.51, -2],
      [126.5, 127],
      [-126.5, -126],
      [1000, 127],
      [-1000, -127],
    ] as const) {
      expect(quantizePitch(input)).toBe(expected)
    }
  })

  it('keeps an elevated long-range rifle hit through input batching and binary encoding', () => {
    const world = testWorld()
    const shooter = place(world, 20, 64)
    const target = place(world, 54.5, 64)
    target.y = 1.3
    recordHistory(world, () => HIST_ALIVE)
    const frame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0, pitch: 2 }
    const batcher = new InputBatcher()
    batcher.push(frame)
    const batch = batcher.push(frame)
    if (!batch) {
      throw new Error('missing two-frame input batch')
    }
    const bytes = encodeInput(new Writer(), { ...batch, ackTick: 0, ackAgeMs: 0 })
    shooter.pitch = decodeInput(bytes)?.frames[0]?.pitch ?? 0
    expect(shooter.pitch).toBe(2)
    const ray = shotRay(shooter, 0)
    ray.maxT = 35
    expect(traceTargets(world, shooter, ray, world.tick)?.id).toBe(target.id)
  })

  it('corrects both angles from a displaced shoulder camera to an elevated target', () => {
    const camera = new Vector3(20, 8, 64)
    const eye = { x: 23, y: 7.62, z: 64.8 }
    const pitch = Math.atan2(6.1 - camera.y, 10)
    const target = rider(1, 30, 5, 64)
    const r = resolveAim(camera, 0, pitch, eye, grid, [target], result())
    expect(r.target).toBe(1)
    expect(Math.abs(r.pitch - pitch)).toBeGreaterThan(0.01)
    const end = predictShot(grid, eye, r.yaw, r.pitch, 35, [target], new Vector3())
    expect(end.distanceTo(r.point)).toBeLessThan(0.01)
    expect(end.y).toBeGreaterThan(5)
    expect(end.y).toBeLessThan(6.8)
  })

  it('keeps close targets in front of the player corrected rather than using camera yaw', () => {
    const camera = new Vector3(20, 1.8, 64)
    const eye = { x: 22.7, y: 1.62, z: 64.3 }
    const r = resolveAim(camera, 0, 0, eye, grid, [rider(1, 23.8, 0, 64)], result())
    expect(r.target).toBe(1)
    expect(r.yaw).toBeLessThan(-0.2)
    expect(r.pitch).toBeGreaterThan(0)
  })

  it('does not target the empty space above a crouched rider', () => {
    const camera = new Vector3(20, 1.65, 64)
    const standing = resolveAim(camera, 0, 0, camera, grid, [rider(1, 25, 0, 64)], result())
    const crouching = resolveAim(
      camera,
      0,
      0,
      camera,
      grid,
      [{ ...rider(1, 25, 0, 64), stance: STANCE_CROUCH }],
      result(),
    )
    expect(standing.target).toBe(1)
    expect(crouching.target).toBe(-1)
  })

  it('predicts downward shots at the ground instead of a horizontal planar wall', () => {
    const eye = { x: 20, y: 8.62, z: 64 }
    const end = predictShot(grid, eye, 0, -Math.PI / 4, 35, [], new Vector3())
    expect(end.y).toBeLessThan(0.16)
    expect(end.x).toBeCloseTo(28.62, 0)
    expect(end.z).toBe(64)
  })
})
