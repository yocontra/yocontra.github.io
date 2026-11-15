import { expect, test as it } from 'bun:test'
import { frameTarget } from '../tools/content/frame-target.ts'
import { frameTiming } from '../tools/content/frame-timing.ts'

it('does not apply the simulator floor as desktop acceptance', () => {
  const timing = frameTiming(Array.from({ length: 2101 }, (_, index) => (index * 1000) / 35))
  expect(frameTarget(timing, 'desktop').passed).toBe(false)
  expect(frameTarget(timing, 'simulator').passed).toBe(true)
})
it('requires a full minute and preserves individual slow seconds', () => {
  const fast = frameTiming(Array.from({ length: 3601 }, (_, index) => (index * 1000) / 60))
  expect(frameTarget(fast, 'desktop').passed).toBe(true)
  expect(
    frameTarget(
      { ...fast, bins: fast.bins.map((bin, index) => (index === 5 ? { ...bin, fps: 20 } : bin)) },
      'desktop',
    ).passed,
  ).toBe(false)
  expect(frameTarget(frameTiming([0, 16, 32]), 'desktop').passed).toBe(false)
})
