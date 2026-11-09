import { expect, test as it } from 'bun:test'
import { microphoneFailure } from '../../src/experiments/out-west/voice/meeting.ts'

it('microphone denial and device failures explain the recovery action', () => {
  for (const permission of ['DENIED', 'SYSTEM_DENIED']) {
    expect(microphoneFailure(permission)).toContain('Allow microphone access')
  }
  expect(microphoneFailure('NO_DEVICES_AVAILABLE')).toContain('Connect a microphone')
  expect(microphoneFailure('COULD_NOT_START')).toContain('other apps')
  expect(microphoneFailure('NOT_REQUESTED')).toContain('Retry voice')
  expect(microphoneFailure(undefined)).toContain('allow microphone access')
})
