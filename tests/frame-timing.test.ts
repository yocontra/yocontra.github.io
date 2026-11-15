import { expect, test } from 'bun:test'
import { frameTiming } from '../tools/content/frame-timing.ts'

test('frame evidence retains empty seconds, long stalls and the final partial bin', () => {
  const result = frameTiming([100, 600, 1100, 3600])
  expect(result.bins).toEqual([
    { startMs: 0, durationMs: 1000, frames: 2, fps: 2 },
    { startMs: 1000, durationMs: 1000, frames: 0, fps: 0 },
    { startMs: 2000, durationMs: 1000, frames: 0, fps: 0 },
    { startMs: 3000, durationMs: 500, frames: 1, fps: 2 },
  ])
  expect(result.intervals).toEqual([500, 500, 2500])
  expect(result.frameMs).toEqual({ p50: 500, p95: 2500, p99: 2500, max: 2500 })
  expect(result.frames).toBe(3)
})

test('exact second boundaries produce no empty trailing bin', () => {
  expect(frameTiming([0, 500, 1000, 1500, 2000]).bins).toHaveLength(2)
})

test('invalid or nonmonotonic timing evidence is rejected', () => {
  for (const samples of [[], [0], [0, 0], [1, 0], [0, Number.NaN]]) {
    expect(() => frameTiming(samples)).toThrow()
  }
})
