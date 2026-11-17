import { expect, test as it } from 'bun:test'
import process from 'node:process'
import { serve, spawn, which } from 'bun'
import { cleanupGuest } from '../tools/content/simulator-cleanup.ts'
import {
  bounded,
  type OwnedPipe,
  type OwnedProcess,
  stopOwned,
  until,
} from '../tools/content/simulator-process.ts'

async function dummy(
  message: string | null = 'READY',
  onOwned?: (child: OwnedProcess, pipe: OwnedPipe) => void,
  timeout = 1000,
) {
  const announcement = message === null ? '' : `console.log(${JSON.stringify(message)});`
  const child = spawn(
    [
      process.execPath,
      '-e',
      `process.on('SIGTERM',()=>{});${announcement}setInterval(()=>{},1000)`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = child.stdout.getReader()
  const first = reader.read()
  const done = (async () => {
    await first
    while (!(await reader.read()).done) {
      /* drain owned pipe */
    }
  })()
  const pipe = { done, cancel: () => reader.cancel() }
  try {
    onOwned?.(child, pipe)
    const value = await bounded(() => first, timeout)
    if (!new TextDecoder().decode(value.value).includes('READY')) {
      throw new Error('Owned dummy did not install its TERM handler')
    }
    return { child, pipe }
  } catch (error) {
    await stopOwned(child, [pipe])
    throw error
  }
}
it('cleans up owned children and pending pipe reads on missing or invalid startup READY', async () => {
  for (const message of [null, 'WRONG'] as const) {
    let owned: { child: OwnedProcess; pipe: OwnedPipe } | undefined
    try {
      await expect(
        dummy(
          message,
          (child, pipe) => {
            owned = { child, pipe }
          },
          message === null ? 100 : 1000,
        ),
      ).rejects.toThrow(message === null ? 'deadline' : 'TERM handler')
      if (!owned) {
        throw new Error('Negative startup control did not spawn its owned child')
      }
      const stopped = owned
      await bounded(() => stopped.pipe.done, 100)
      expect(await stopped.child.exited).not.toBe(0)
      expect(() => process.kill(stopped.child.pid, 0)).toThrow()
    } finally {
      if (owned) {
        await stopOwned(owned.child, [owned.pipe])
      }
    }
  }
})
it('aborts a real stalled HTTP response at the remaining poll budget', async () => {
  let received = false
  let aborted = false
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      received = true
      return new Promise<Response>(() => undefined)
    },
  })
  try {
    await expect(
      until(async (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        await fetch(server.url, { signal })
        return true
      }, 0.08),
    ).rejects.toThrow('deadline')
    expect(received).toBe(true)
    expect(aborted).toBe(true)
  } finally {
    await server.stop(true)
  }
})
it('escalates only the exact owned TERM-resistant child and drains its pipe', async () => {
  const { child, pipe } = await dummy()
  try {
    const result = await stopOwned(child, [pipe], { term: 30, kill: 500, drain: 500 })
    expect(result.escalated).toBe(true)
    expect(result.pipeDrainComplete).toBe(true)
    expect(await child.exited).not.toBe(0)
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null) {
      await stopOwned(child, [pipe])
    }
  }
})
it('still closes the owned process and attempts shutdown after stalled restore and close RPC', async () => {
  const { child, pipe } = await dummy()
  const calls: string[] = []
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === '/health'
        ? new Response('caller-owned-alive')
        : new Promise<Response>(() => undefined),
  })
  const stop = () => stopOwned(child, [pipe], { term: 30, kill: 500, drain: 500 })
  try {
    const cleanup = await cleanupGuest({
      booted: true,
      native: {
        pid: child.pid,
        call: (op, args) => {
          calls.push(op)
          return Promise.resolve(op === 'get-orientation' ? 'PORTRAIT' : args?.value)
        },
        close: () => {
          calls.push('close')
          return new Promise(() => undefined)
        },
        terminate: stop,
      },
      companion: undefined,
      run: (args) => {
        calls.push(args[2] ?? '')
        return Promise.resolve(
          args[2] === 'list'
            ? JSON.stringify({
                devices: {
                  iOS: [{ udid: '59616A95-4749-4F6F-8E1D-1FAEA0263EFC', state: 'Shutdown' }],
                },
              })
            : '',
        )
      },
      options: { udid: '59616A95-4749-4F6F-8E1D-1FAEA0263EFC', port: 0 },
      stateURL: new URL('/stalled', server.url),
      url: new URL('/__qa/start?id=11111111-1111-4111-8111-111111111111', server.url),
      initialOrientation: 'LANDSCAPE_LEFT',
      budgets: { restore: 60, rpc: 60, close: 60, shutdown: 200 },
    })
    expect(cleanup.settingsRestoreFailure).toBeDefined()
    expect(cleanup.nativeClientFailure).toBeDefined()
    expect(cleanup.orientationRestored).toBe(true)
    expect(calls.indexOf('orientation')).toBeLessThan(calls.indexOf('close'))
    expect(calls.indexOf('close')).toBeLessThan(calls.indexOf('shutdown'))
    expect(cleanup.deviceShutdown).toBe(true)
    expect(cleanup.ownedPidsAbsent).toBe(true)
    expect(await child.exited).not.toBe(0)
    expect(await (await fetch(new URL('/health', server.url))).text()).toBe('caller-owned-alive')
  } finally {
    if (child.exitCode === null) {
      await stop()
    }
    await server.stop(true)
  }
})
it('executes the offline fake-clock native iterator regressions without idb or device connection', async () => {
  const python = which('python3')
  if (!python) {
    throw new Error('Offline scheduler tests require python3 on PATH (no idb dependency)')
  }
  const child = spawn([python, '-B', 'tests/simulator-schedule.py'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const error = await new Response(child.stderr).text()
  await child.exited
  expect(child.exitCode).toBe(0)
  expect(error).toContain('Ran 4 tests')
})
