import { expect, test as it } from 'bun:test'
import { serve } from 'bun'
import { cleanupGuest } from '../tools/content/simulator-cleanup.ts'
import { waitForSettingsRestore } from '../tools/content/simulator-process.ts'

it('waits through real HTTP404 and pending200 until the explicit settings ACK', async () => {
  const statuses: number[] = []
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      const response =
        statuses.length === 0
          ? new Response('Not ready', { status: 404 })
          : Response.json(statuses.length === 1 ? { stage: 'ready' } : { settingsRestored: true })
      statuses.push(response.status)
      return response
    },
  })
  try {
    // Same shared waiter and budget used by the preflight caller; no native actions.
    expect(await waitForSettingsRestore(server.url, 2)).toBe(true)
    expect(statuses).toEqual([404, 200, 200])
  } finally {
    await server.stop(true)
  }
})

it('fails within the original budget when a valid status never supplies an ACK', async () => {
  let requests = 0
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      requests++
      return Response.json({ stage: 'ready' })
    },
  })
  try {
    await expect(waitForSettingsRestore(server.url, 0.08)).rejects.toThrow('deadline')
    expect(requests).toBeGreaterThan(0)
  } finally {
    await server.stop(true)
  }
})

it('preserves malformed200 and HTTP500 failures instead of polling them as pending', async () => {
  for (const [response, expectedFailure] of [
    [new Response('Not JSON', { status: 200 }), 'SyntaxError'],
    [Response.json(null), 'Malformed settings restore status'],
    [Response.json([]), 'Malformed settings restore status'],
    [Response.json({ settingsRestored: 'true' }), 'Malformed settings restore acknowledgement'],
    [Response.json({ settingsRestored: false }), 'Guest settings restoration reported failure'],
    [new Response('Server failure', { status: 500 }), 'HTTP 500'],
  ] as const) {
    let requests = 0
    const server = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        requests++
        return response.clone()
      },
    })
    try {
      let failure: unknown
      try {
        await waitForSettingsRestore(server.url, 1)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain('deadline')
      expect(String(failure)).toContain(expectedFailure)
      expect(requests).toBe(1)
    } finally {
      await server.stop(true)
    }
  }
})

it('preserves real network failures', async () => {
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') })
  try {
    const address = new URL(server.url)
    await server.stop(true)
    let failure: unknown
    try {
      await waitForSettingsRestore(address, 1)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('deadline')
  } finally {
    await server.stop(true)
  }
})

it('keeps the shared restore wait abortable when the HTTP response stalls', async () => {
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  })
  try {
    await expect(waitForSettingsRestore(server.url, 0.08)).rejects.toThrow('deadline')
  } finally {
    await server.stop(true)
  }
})

it('cleanupGuest uses the same waiter and still attempts shutdown after HTTP500', async () => {
  const commands: string[] = []
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('Server failure', { status: 500 }),
  })
  try {
    const cleanup = await cleanupGuest({
      booted: true,
      native: undefined,
      companion: undefined,
      run: (args) => {
        commands.push(args[2] ?? '')
        return Promise.resolve(
          args[2] === 'list'
            ? JSON.stringify({ devices: { iOS: [{ udid: 'owned-fixture', state: 'Shutdown' }] } })
            : '',
        )
      },
      options: { udid: 'owned-fixture', port: 0 },
      stateURL: server.url,
      url: new URL('/__qa/start?id=11111111-1111-4111-8111-111111111111', server.url),
      initialDisplay: undefined,
      qaPageAttempted: true,
      budgets: { restore: 1000, rpc: 100, close: 100, shutdown: 100 },
    })
    expect(cleanup.settingsRestored).toBeUndefined()
    expect(String(cleanup.settingsRestoreFailure)).toContain('HTTP 500')
    expect(commands).toEqual(['openurl', 'shutdown', 'list'])
    expect(cleanup.deviceShutdown).toBe(true)
  } finally {
    await server.stop(true)
  }
})

it('skips settings navigation before any QA URL and still shuts down the owned device', async () => {
  const commands: string[] = []
  const cleanup = await cleanupGuest({
    booted: true,
    native: undefined,
    companion: undefined,
    run: (args) => {
      commands.push(args[2] ?? '')
      return Promise.resolve(
        args[2] === 'list'
          ? JSON.stringify({ devices: { iOS: [{ udid: 'owned-fixture', state: 'Shutdown' }] } })
          : '',
      )
    },
    options: { udid: 'owned-fixture', port: 0 },
    stateURL: new URL('http://127.0.0.1:1/unused'),
    url: new URL('http://127.0.0.1:1/unused'),
    initialDisplay: undefined,
    qaPageAttempted: false,
    budgets: { restore: 100, rpc: 100, close: 100, shutdown: 100 },
  })
  expect(commands).toEqual(['shutdown', 'list'])
  expect(cleanup.settingsRestored).toBeUndefined()
  expect(cleanup.settingsRestoreSkipped).toContain('No QA URL')
  expect(cleanup.deviceShutdown).toBe(true)
})
