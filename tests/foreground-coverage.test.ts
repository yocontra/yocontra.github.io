import { expect, test as it } from 'bun:test'
import { foregroundCoverage } from '../tools/content/foreground-coverage.ts'

const expected = { start: 0, end: 60_000, bundle: 'com.google.Chrome', pid: 123 }
const covered = Array.from({ length: 59 }, (_, index) => ({
  wall: 400 + (index * 59_200) / 58,
  bundle: expected.bundle,
  pid: expected.pid,
  onScreenWindows: 1,
}))

it('accepts 59 samples that cover both boundaries without an unobserved interval', () => {
  expect(foregroundCoverage(covered, expected).passed).toBe(true)
})
it('rejects a missing interval or either missing recording boundary', () => {
  expect(
    foregroundCoverage(
      covered.filter((_, index) => index !== 20),
      expected,
    ).passed,
  ).toBe(false)
  expect(foregroundCoverage(covered.slice(1), expected).passed).toBe(false)
  expect(foregroundCoverage(covered.slice(0, -1), expected).passed).toBe(false)
})
it('rejects foreground switches, virtual windows, wrong identities and reordered samples', () => {
  for (const change of [
    { bundle: 'com.googlecode.iterm2' },
    { pid: 456 },
    { onScreenWindows: 0 },
    { wall: -1 },
  ]) {
    const samples = covered.map((sample, index) =>
      index === 20 ? { ...sample, ...change } : sample,
    )
    expect(foregroundCoverage(samples, expected).passed).toBe(false)
  }
  expect(foregroundCoverage(covered, { ...expected, pid: undefined }).passed).toBe(false)
  expect(foregroundCoverage(covered, { ...expected, pid: -1 }).passed).toBe(false)
  expect(foregroundCoverage([], expected).passed).toBe(false)
})
