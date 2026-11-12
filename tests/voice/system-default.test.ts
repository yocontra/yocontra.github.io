import { expect, test as it } from 'bun:test'
import { systemDefaultMoved } from '../../src/experiments/out-west/voice/input-device.ts'

const input = (deviceId: string, groupId: string) => ({
  kind: 'audioinput' as const,
  deviceId,
  groupId,
})
const output = { kind: 'audiooutput' as const, deviceId: 'default', groupId: 'speakers' }

it('Chromium default capture follows the default entry group', () => {
  const devices = [
    output,
    input('default', 'headset'),
    input('mac', 'built-in'),
    input('usb', 'headset'),
  ]
  expect(systemDefaultMoved({ deviceId: 'default', groupId: 'headset' }, devices)).toBe(false)
  expect(systemDefaultMoved({ deviceId: 'default', groupId: 'built-in' }, devices)).toBe(true)
  expect(systemDefaultMoved({ deviceId: 'default' }, devices)).toBe(false)
})

it('Safari default capture follows the first listed input', () => {
  const devices = [input('usb', 'headset'), input('mac', 'built-in')]
  expect(systemDefaultMoved({ deviceId: 'usb', groupId: 'headset' }, devices)).toBe(false)
  expect(systemDefaultMoved({ deviceId: 'mac', groupId: 'built-in' }, devices)).toBe(true)
})

it('unlabelled or empty enumerations never restart capture', () => {
  expect(systemDefaultMoved({ deviceId: 'mac' }, [])).toBe(false)
  expect(systemDefaultMoved({ deviceId: 'mac' }, [input('', '')])).toBe(false)
  expect(systemDefaultMoved({}, [input('usb', 'headset')])).toBe(false)
})
