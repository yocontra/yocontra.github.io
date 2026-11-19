import { expect, test as it } from 'bun:test'
import process from 'node:process'
import { cleanupGuest } from '../tools/content/simulator-cleanup.ts'
import {
  recoverOwnedOrientation,
  restoreOnSameDisplay,
} from '../tools/content/simulator-display-recovery.ts'
import { cleanupComplete } from '../tools/content/simulator-hid.ts'
import { QA_DEVICE, requireBootedRecoveryDevice } from '../tools/content/simulator-native.ts'
import { initialDisplay } from '../tools/content/simulator-orientation.ts'
import fixture from './fixtures/simulator-coordinate-v3.json' with { type: 'json' }

const initial = { ...initialDisplay(QA_DEVICE, fixture, 'UNKNOWN'), commandAttempted: true }
const retiredPID = 2_147_000_001
const timeout = 'Owned native RPC timed out: apps'
const list = (devices: unknown[]) => ({ devices: { iOS: devices } })
const device = {
  udid: QA_DEVICE,
  state: 'Booted',
  name: 'Out West QA iPhone 13 mini',
  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini',
}
function cleanupFixture(pid = retiredPID) {
  const calls: string[] = []
  const recoveryTargets: { udid: string; signature: string }[] = []
  const url = new URL('http://127.0.0.1:1/unused')
  const context: Parameters<typeof cleanupGuest>[0] = {
    booted: true,
    native: {
      pid,
      call: () => Promise.reject(new Error(timeout)),
      close: () => {
        calls.push('close old bridge')
        return Promise.resolve({ pid, exitCode: 0, pipeDrainComplete: true })
      },
      terminate: () => Promise.reject(new Error('Unexpected terminate')),
    },
    companion: {
      pid: retiredPID,
      exitCode: 0,
      exited: Promise.resolve(0),
      kill: () => {
        throw new Error('Do not signal a retired process')
      },
    },
    run: (args) => {
      calls.push(args[2] ?? '')
      return Promise.resolve(
        args[2] === 'list' ? JSON.stringify(list([{ ...device, state: 'Shutdown' }])) : '',
      )
    },
    options: { udid: QA_DEVICE, port: 0, python: 'unused-python', output: '/unused' },
    stateURL: url,
    url,
    initialDisplay: initial,
    qaPageAttempted: false,
    budgets: { restore: 100, rpc: 100, close: 100, shutdown: 100 },
    recoverOrientation: (options) => {
      recoveryTargets.push({ udid: options.udid, signature: options.initial.signature })
      calls.push('fresh companion')
      return Promise.resolve({
        displayRestored: true,
        rawOrientationRestored: false,
        ownedPids: [retiredPID + 1, retiredPID + 2],
        observations: [],
      })
    },
  }
  return { context, calls, recoveryTargets }
}

it('restores through a fresh owner before shutdown and retains the failed original attempt', async () => {
  const { context, calls, recoveryTargets } = cleanupFixture()
  const cleanup = await cleanupGuest(context)
  expect(calls).toEqual(['close old bridge', 'fresh companion', 'shutdown', 'list'])
  expect(recoveryTargets).toEqual([{ udid: QA_DEVICE, signature: initial.signature }])
  expect(cleanup.orientationRestoreFailure).toContain(timeout)
  expect(cleanup.displayRestored).toBe(true)
  expect(cleanup.rawOrientationRestored).toBe(false)
  expect(cleanup.deviceShutdown).toBe(true)
  expect(cleanup.ownedPids).toContain(retiredPID + 2)
  expect(cleanupComplete({ ...cleanup, settingsRestored: true })).toBe(false)
})

it('does not reopen a companion while an original handle still has a live PID', async () => {
  const { context, calls } = cleanupFixture(process.pid)
  const cleanup = await cleanupGuest(context)
  expect(calls).toEqual(['close old bridge', 'shutdown', 'list'])
  expect(cleanup.orientationRecoverySkipped).toContain('processes have not exited')
  expect(cleanup.ownedPidsAbsent).toBe(false)
})

it('still shuts down the owned device when the recovery itself errors', async () => {
  const { context, calls } = cleanupFixture()
  context.recoverOrientation = () => Promise.reject(new Error('Recovery fixture unavailable'))
  const cleanup = await cleanupGuest(context)
  expect(calls).toEqual(['close old bridge', 'shutdown', 'list'])
  expect(cleanup.orientationRestoreFailure).toContain(timeout)
  expect(cleanup.orientationRecoveryFailure).toContain('Recovery fixture unavailable')
  expect(cleanup.deviceShutdown).toBe(true)
})

it('requires one exact booted dedicated simulator and does not attempt a new boot', async () => {
  expect(() => requireBootedRecoveryDevice(list([device]), QA_DEVICE)).not.toThrow()
  for (const devices of [
    [{ ...device, udid: crypto.randomUUID() }],
    [{ ...device, name: 'General purpose iPhone' }],
    [{ ...device, state: 'Shutdown' }],
    [{ ...device, isAvailable: false }],
    [device, device],
  ]) {
    expect(() => requireBootedRecoveryDevice(list(devices), QA_DEVICE)).toThrow('not still booted')
  }

  const commands: string[][] = []
  const result = await recoverOwnedOrientation({
    udid: QA_DEVICE,
    port: 0,
    python: 'unused-python',
    output: '/unused',
    initial,
    run(args) {
      commands.push(args)
      return Promise.resolve(JSON.stringify(list([{ ...device, state: 'Shutdown' }])))
    },
  })
  expect(commands).toEqual([['xcrun', 'simctl', 'list', 'devices', 'available', '--json']])
  expect(result.failure).toContain('not still booted')
  expect(result.ownedPids).toEqual([])
})

it('proves same Safari and display before writing and obtains two exact portrait readbacks', async () => {
  const ax = structuredClone(fixture.ax)
  ax.screen.display.rotation = 270
  ax.screen.width = 812
  ax.screen.height = 375
  const calls: string[] = []
  const observations: Record<string, unknown>[] = []
  const requested: unknown[] = []
  const restored = await restoreOnSameDisplay(
    {
      call(op, args) {
        calls.push(op)
        if (op === 'orientation') {
          requested.push(args?.value)
          Object.assign(ax.screen, { width: 375, height: 812 })
          ax.screen.display.rotation = 0
          return Promise.resolve('PORTRAIT')
        }
        if (op === 'ax') {
          return Promise.resolve(structuredClone(ax))
        }
        return Promise.resolve(op === 'apps' ? fixture.apps : 'PORTRAIT')
      },
    },
    initial,
    (value) => observations.push(value),
  )
  expect(calls).toEqual([
    'ax',
    'apps',
    'orientation',
    'ax',
    'apps',
    'get-orientation',
    'ax',
    'apps',
    'get-orientation',
  ])
  expect(requested).toEqual(['PORTRAIT'])
  expect(observations[0]?.phase).toBe('recovery-identity')
  expect(restored.displayRestored).toBe(true)
  expect(restored.rawOrientationRestored).toBe(false)
})

it.each([
  { ...initial, safariPID: initial.safariPID + 1 },
  {
    ...initial,
    screen: { ...initial.screen, display: { ...initial.screen.display, unique_id: 'changed' } },
  },
])('sends no orientation command when Safari or the display cannot be proved', async (altered) => {
  const calls: string[] = []
  let failure: unknown
  try {
    await restoreOnSameDisplay(
      {
        call(op) {
          calls.push(op)
          return Promise.resolve(op === 'ax' ? fixture.ax : fixture.apps)
        },
      },
      altered,
      () => undefined,
    )
  } catch (error) {
    failure = error
  }
  expect(String(failure)).toContain('Native Safari or display changed')
  expect(calls).toEqual(['ax', 'apps'])
})
