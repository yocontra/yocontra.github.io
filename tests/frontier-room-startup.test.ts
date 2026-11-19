import { afterAll, beforeAll, expect, test as it, spyOn } from 'bun:test'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { SeatReservation } from '@colyseus/sdk'
import { spawn } from 'bun'
import {
  FrontierRoomClient,
  waitForPlayer,
} from '../src/experiments/out-west/client/frontier-room-client.ts'
import type { ConnectionNotice } from '../src/experiments/out-west/client/reconnect-session.ts'
import { TOWN_CLOSE_REPLACED } from '../src/experiments/out-west/contract/town.ts'
import { FrontierState } from '../src/experiments/out-west/runtime/schema.ts'
import { nextDeposit, roomEvent, sessionId } from './fixtures/frontier-room-server.ts'

let fixture: ReturnType<typeof startServer> | undefined
let endpoint: string

// Bun 1.3 test workers can hang starting or stopping their own listeners.
function startServer() {
  return spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./fixtures/frontier-room-server.ts', import.meta.url)),
    ],
    {
      stdout: 'pipe',
      stderr: 'inherit',
    },
  )
}

beforeAll(async () => {
  fixture = startServer()
  const reader = fixture.stdout.getReader()
  try {
    const { value } = await reader.read()
    if (!value) {
      throw new Error('Frontier room fixture closed before reporting its endpoint')
    }
    endpoint = new TextDecoder().decode(value).trim()
  } finally {
    reader.releaseLock()
  }
})

afterAll(async () => {
  fixture?.kill()
  await fixture?.exited
})

function seat(roomId: string): SeatReservation {
  return { name: 'frontier', roomId, processId: 'local', sessionId }
}

it('keeps the latest startup wallet in the real SDK without replaying old room effects', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  const client = new FrontierRoomClient(endpoint, 100)
  const { promise, resolve } = Promise.withResolvers<void>()
  const delivered: unknown[] = []
  try {
    const room = await client.consumeSeatReservation(seat('wallet'), FrontierState)
    expect((await waitForPlayer(room, client.signal)).id).toBe('4')
    expect(client.banked).toBe(200)
    client.attach({
      events(events) {
        delivered.push(...events)
      },
      control(control) {
        delivered.push(control)
        resolve()
      },
    })
    expect(delivered).toEqual([])
    room.send('fixture-next')
    await promise
    expect(client.banked).toBe(275)
    expect(delivered).toEqual([roomEvent, nextDeposit])
    expect(warn).not.toHaveBeenCalled()
    await room.leave()
  } finally {
    warn.mockRestore()
    client.release()
  }
})

it('rejects the first-state wait with the real SDK close reason and code', async () => {
  const notices: Parameters<ConnectionNotice>[] = []
  const client = new FrontierRoomClient(endpoint, 100, (...args) => notices.push(args))
  try {
    const room = await client.consumeSeatReservation(seat('replacement'), FrontierState)
    const pending = waitForPlayer(room, client.signal).catch((reason: unknown) => reason)
    room.send('fixture-close')
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'Joined from somewhere else.' })
    expect(notices).toEqual([['closed', 'Joined from somewhere else.', TOWN_CLOSE_REPLACED]])
    expect(() => client.attach({ control: () => undefined, events: () => undefined })).toThrow(
      'Joined from somewhere else.',
    )
  } finally {
    client.release()
  }
})
