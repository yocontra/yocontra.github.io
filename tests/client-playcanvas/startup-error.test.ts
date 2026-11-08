import { expect, test as it } from 'bun:test'
import { startupFailure } from '../../src/experiments/out-west/client/startup-error.ts'

it('download and decoder failures offer retry without claiming the device lacks WebGL2', () => {
  for (const message of [
    'Failed to fetch dynamically imported module',
    'Outdated Optimize Dep',
    'Could not load outlaw.glb',
  ]) {
    expect(startupFailure(new Error(message))).toContain('connection')
    expect(startupFailure(new Error(message))).not.toContain('WebGL2')
  }
})
it('a graphics initialization failure offers the original game as a fallback', () => {
  expect(startupFailure(new Error('Failed to create WebGL graphics device'))).toContain(
    '3D graphics',
  )
  expect(startupFailure(new Error('Failed to create WebGL graphics device'))).toContain(
    '2019 original',
  )
})
