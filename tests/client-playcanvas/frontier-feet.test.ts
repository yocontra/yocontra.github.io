/** Nearby stationary/sliding riders must not consume the moving riders' audible footstep slots. */
import { expect, test as it } from 'bun:test'
import type {
  Emitter,
  FrontierAudio,
  PlayOptions,
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
    ['sliding', pose(3, 7, true)],
    ['approaching', pose(4, 4)],
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
    expect(removed).toHaveLength(4)
  } finally {
    feet.destroy()
  }
})

it('spatializes nearby enemy footfalls while keeping own feet and gear on their existing path', () => {
  const played: { source: string; name: string; binaural: boolean }[] = []
  const audio = {
    clock: 0,
    distance: () => 2,
    emitter: (name: string) => ({
      entity: { name, setPosition: () => undefined, destroy: () => undefined },
    }),
    playOn: (emitter: Emitter, name: string, options: PlayOptions) => {
      played.push({ source: emitter.entity.name, name, binaural: Boolean(options.binaural) })
    },
  }
  const feet = new FrontierFeet(audio as unknown as FrontierAudio)
  const moving: RiderPose = { x: 0, y: 0.9, z: 0, vx: 4, vy: 0, grounded: true }
  const riders = new Map([
    ['self', moving],
    ['enemy', { ...moving, x: 2 }],
  ])
  try {
    for (let tick = 0; tick < 30; tick++) {
      audio.clock += 0.05
      feet.update(0.05, riders, 'self', () => undefined)
    }
    const own = played.filter((event) => event.source === 'feet-self')
    const enemy = played.filter(
      (event) => event.source === 'feet-enemy' && event.name.startsWith('step'),
    )
    expect(own.length).toBeGreaterThan(0)
    expect(enemy.length).toBeGreaterThan(0)
    expect(own.every((event) => !event.binaural)).toBe(true)
    expect(enemy.every((event) => event.binaural)).toBe(true)
    // A nearby jump also emits cloth; only its actual boot contact needs the HRTF voice.
    riders.set('enemy', { ...moving, x: 2, grounded: false, vy: 2 })
    audio.clock += 0.05
    feet.update(0.05, riders, 'self', () => undefined)
    expect(played.filter((event) => event.name === 'cloth').map((event) => event.binaural)).toEqual(
      [false],
    )
  } finally {
    feet.destroy()
  }
})
