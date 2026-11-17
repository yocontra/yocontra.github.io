/** Nearby stationary/sliding riders must not consume the moving riders' audible footstep slots. */
import { expect, test as it } from 'bun:test'
import { stepSurface } from '../../src/experiments/out-west/client/audio-surfaces.ts'
import type {
  Emitter,
  FrontierAudio,
} from '../../src/experiments/out-west/client/frontier-audio.ts'
import {
  FrontierFeet,
  type RiderPose,
} from '../../src/experiments/out-west/client/frontier-feet.ts'

it('stationary and sliding riders cannot hide an approaching enemy footstep cue', () => {
  const played: string[] = []
  const removed: string[] = []
  const audio = {
    clock: 0,
    surfaceAt: (at: { x: number; y: number; z: number }) => stepSurface(at.x, at.y, at.z),
    distance: (p: { x: number; y: number; z: number }) => Math.hypot(p.x, p.z),
    emitter: (name: string) => ({
      entity: { name, setPosition: () => undefined, destroy: () => removed.push(name) },
    }),
    playOn: (emitter: Emitter) => played.push(emitter.entity.name),
  }
  const feet = new FrontierFeet(audio as unknown as FrontierAudio)
  const pose = (x: number, vx = 0, crouched = false): RiderPose => ({
    x,
    y: 0.9,
    z: 0,
    vx,
    vy: 0,
    vz: 0,
    grounded: true,
    crouched,
  })
  const riders = new Map([
    ['stationary-a', pose(1)],
    ['stationary-b', pose(2)],
    ['stationary-c', pose(3)],
    ['stationary-d', pose(4)],
    ['sliding', pose(5, 7, true)],
    ['approaching', pose(6, 4)],
  ])
  try {
    for (let tick = 0; tick < 20; tick++) {
      audio.clock += 0.05
      feet.update(0.05, riders, 'self', () => undefined)
    }
    expect(played).toContain('feet-approaching')
    expect(played).not.toContain('feet-stationary-a')
    expect(played).not.toContain('feet-stationary-b')
    expect(played).not.toContain('feet-sliding')
    riders.clear()
    feet.update(0.05, riders, 'self', () => undefined)
    expect(removed).toHaveLength(6)
  } finally {
    feet.destroy()
  }
})
