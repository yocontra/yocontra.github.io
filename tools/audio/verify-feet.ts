// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone behavioral regression for the live footstep scheduler.
/** Nearby stationary/sliding riders must not consume the moving riders' audible footstep slots. */
import assert from 'node:assert/strict'
import type {
  Emitter,
  FrontierAudio,
} from '../../src/experiments/out-west/client/frontier-audio.ts'
import {
  FrontierFeet,
  type RiderPose,
} from '../../src/experiments/out-west/client/frontier-feet.ts'

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
  assert.ok(played.includes('feet-approaching'), 'nearest moving enemy must remain audible')
  assert.ok(!played.includes('feet-stationary-a'))
  assert.ok(!played.includes('feet-stationary-b'))
  assert.ok(!played.includes('feet-sliding'))
  riders.clear()
  feet.update(0.05, riders, 'self', () => undefined)
  assert.equal(removed.length, 4, 'all departed rider emitters must be released')
} finally {
  feet.destroy()
}
console.log(
  'PASS: stationary and sliding riders cannot hide a moving enemy footstep cue; emitter cleanup verified',
)
