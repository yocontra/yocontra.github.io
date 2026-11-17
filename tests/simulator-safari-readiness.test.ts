import { expect, test as it } from 'bun:test'
import { safariLaunchArguments } from '../tools/content/simulator-native.ts'
import {
  openSafariWhenReady,
  type SafariReadinessEvent,
} from '../tools/content/simulator-process.ts'

const ready = {
  ax: { target: { kind: 'frontmost' }, elements: [{ type: 'Application', pid: 84_918 }] },
  apps: [{ bundle_id: 'com.apple.mobilesafari', process_id: 84_918 }],
}
function fixture(states = [ready]) {
  const calls: string[] = []
  const events: SafariReadinessEvent[] = []
  let reads = 0
  const options = {
    launch: (_milliseconds: number, _signal: AbortSignal) => {
      calls.push('launch')
      return Promise.resolve('native launch ACK')
    },
    read: (_milliseconds: number, _signal: AbortSignal) => {
      calls.push('read')
      return Promise.resolve(states[Math.min(reads++, states.length - 1)] ?? ready)
    },
    open: (_milliseconds: number, _signal: AbortSignal) => {
      calls.push('open')
      return Promise.resolve('native URL result')
    },
    observe: (event: SafariReadinessEvent) => {
      events.push(event)
    },
    seconds: 1,
  }
  return { calls, events, options }
}
it('keeps native idb options before the Safari bundle and leaves no app arguments', () => {
  const command = safariLaunchArguments((...args) => [
    'idb',
    '--companion',
    '127.0.0.1:10892',
    ...args,
    '--udid',
    'owned-udid',
    '--json',
    '--reason',
    'owned preflight',
  ])
  const bundleIndex = command.indexOf('com.apple.mobilesafari')
  expect(command.slice(3, 5)).toEqual(['launch', '--foreground-if-running'])
  expect(command.indexOf('--udid')).toBeLessThan(bundleIndex)
  expect(command.indexOf('--reason')).toBeLessThan(bundleIndex)
  expect(command.slice(bundleIndex + 1)).toEqual([])
})
it('launches once, proves native foreground identity, then opens once and retains raw results', async () => {
  const value = fixture()
  const identity = await openSafariWhenReady(value.options)
  expect(identity).toEqual({ bundle: 'com.apple.mobilesafari', pid: 84_918 })
  expect(value.calls).toEqual(['launch', 'read', 'open'])
  expect(value.events.map((e) => e.phase)).toEqual(['launch', 'readiness', 'open'])
  expect(value.events[0]?.result).toBe('native launch ACK')
  expect(value.events[1]?.result).toBe(ready)
  expect(value.events[1]?.identity).toEqual(identity)
  expect(value.events[2]?.result).toBe('native URL result')
})
it('retains pending incorrect PID observations without repeating launch or opening early', async () => {
  const wrong = { ...ready, apps: [{ bundle_id: 'com.apple.mobilesafari', process_id: 84_919 }] }
  const value = fixture([wrong, ready])
  await openSafariWhenReady(value.options)
  expect(value.calls).toEqual(['launch', 'read', 'read', 'open'])
  expect(value.events[1]?.result).toBe(wrong)
  expect(value.events[1]?.identity).toBeNull()
  expect(value.events[2]?.identity?.pid).toBe(84_918)
})
it('fails readiness at the deadline for wrong targets, wrong mappings or missing mappings', async () => {
  for (const state of [
    { ...ready, ax: { ...ready.ax, target: { kind: 'pid' } } },
    { ...ready, apps: [{ bundle_id: 'other', process_id: 84_918 }] },
    {
      ax: { AXRole: 'AXApplication', bundleIdentifier: 'com.apple.mobilesafari', pid: 84_918 },
      apps: undefined,
    },
  ]) {
    const value = fixture()
    const options = {
      ...value.options,
      read: () => {
        value.calls.push('read')
        return Promise.resolve(state)
      },
      seconds: 0.04,
    }
    await expect(openSafariWhenReady(options)).rejects.toThrow('deadline')
    expect(value.calls.filter((c) => c === 'launch')).toHaveLength(1)
    expect(value.calls.filter((c) => c === 'open')).toHaveLength(0)
    expect(value.events.find((e) => e.phase === 'readiness')?.result).toBe(state)
    expect(value.events.at(-1)?.error).toContain('deadline')
  }
})
it('keeps launch, readiness RPC and URL failures visible without retrying either action', async () => {
  for (const [phase, expected] of [
    ['launch', ['launch']],
    ['read', ['launch', 'read']],
    ['open', ['launch', 'read', 'open']],
  ] as const) {
    const value = fixture()
    const error = new Error(`Native ${phase} RPC failed`)
    value.options[phase] = () => {
      value.calls.push(phase)
      return Promise.reject<never>(error)
    }
    await expect(openSafariWhenReady(value.options)).rejects.toBe(error)
    expect(value.calls).toEqual([...expected])
    expect(value.events.at(-1)?.phase).toBe(phase === 'read' ? 'readiness' : phase)
    expect(value.events.at(-1)?.error).toContain(error.message)
  }
})
it('aborts a stalled readiness RPC at its remaining deadline and never opens the URL', async () => {
  const value = fixture()
  let aborted = false
  const options = {
    ...value.options,
    seconds: 0.04,
    read: (_remaining: number, signal: AbortSignal) => {
      value.calls.push('read')
      signal.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise<typeof ready>(() => undefined)
    },
  }
  await expect(openSafariWhenReady(options)).rejects.toThrow('deadline')
  expect(aborted).toBe(true)
  expect(value.calls).toEqual(['launch', 'read'])
  expect(value.events.at(-1)?.error).toContain('deadline')
})
