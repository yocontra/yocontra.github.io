import { expect, test as it, spyOn } from 'bun:test'
import { getMessageBytes, Protocol } from '@colyseus/core'
import { Encoder } from '@colyseus/schema'
import type { SeatReservation } from '@colyseus/sdk'
import { type ServerWebSocket, serve } from 'bun'
import {
  FrontierRoomClient,
  waitForPlayer,
} from '../src/experiments/out-west/client/frontier-room-client.ts'
import type { ConnectionNotice } from '../src/experiments/out-west/client/reconnect-session.ts'
import { CONTRACT_VERSION, TOWN_CLOSE_REPLACED } from '../src/experiments/out-west/contract/town.ts'
import { FrontierState, PlayerRecord } from '../src/experiments/out-west/runtime/schema.ts'

const seat: SeatReservation = {
  name: 'frontier',
  roomId: 'room',
  processId: 'local',
  sessionId: 'rider',
}
const roomData = getMessageBytes.raw
const welcome = {
  type: 'welcome',
  contractVersion: CONTRACT_VERSION,
  lobbyId: 'perdition',
  you: 4,
  tick: 22,
  tickHz: 20,
  roster: [],
  banked: 125,
}
const earlyDeposit = {
  type: 'deposit',
  seq: 5,
  amount: 70,
  commission: 5,
  banked: 200,
  ok: true,
}
const event = { type: 'glass_break', window: 1 } as const

function socketRoom(start: (socket: ServerWebSocket<undefined>) => void) {
  const { promise: peer, resolve } = Promise.withResolvers<ServerWebSocket<undefined>>()
  const server = serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, listener) {
      if (listener.upgrade(req)) {
        return
      }
      return new Response('Expected WebSocket upgrade', { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.send(getMessageBytes[Protocol.JOIN_ROOM]('resume-token', 'schema'))
        start(socket)
        resolve(socket)
      },
      message: () => undefined,
    },
  })
  return { server, peer, endpoint: server.url.toString() }
}

it('keeps the latest startup wallet in the real SDK without replaying old room effects', async () => {
  const state = new FrontierState()
  const player = new PlayerRecord()
  player.id = '4'
  player.sessionId = seat.sessionId
  state.players.set(player.id, player)
  const initialState = Uint8Array.of(Protocol.ROOM_STATE, ...new Encoder(state).encodeAll())
  const fixture = socketRoom((socket) => {
    socket.send(roomData(Protocol.ROOM_DATA, 'control', welcome))
    socket.send(roomData(Protocol.ROOM_DATA, 'control', earlyDeposit))
    socket.send(roomData(Protocol.ROOM_DATA, 'events', { tick: 22, events: [event] }))
    socket.send(initialState)
  })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  const client = new FrontierRoomClient(fixture.endpoint, 100)
  const { promise, resolve } = Promise.withResolvers<void>()
  const delivered: unknown[] = []
  try {
    const room = await client.consumeSeatReservation(seat, FrontierState)
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
    const socket = await fixture.peer
    const nextDeposit = { ...earlyDeposit, seq: 6, banked: 275 }
    socket.send(roomData(Protocol.ROOM_DATA, 'events', { tick: 30, events: [event] }))
    socket.send(roomData(Protocol.ROOM_DATA, 'control', nextDeposit))
    await promise
    expect(client.banked).toBe(275)
    expect(delivered).toEqual([event, nextDeposit])
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
    client.release()
    await fixture.server.stop(true)
  }
})

it('rejects the first-state wait with the real SDK close reason and code', async () => {
  const fixture = socketRoom(() => undefined)
  const notices: Parameters<ConnectionNotice>[] = []
  const client = new FrontierRoomClient(fixture.endpoint, 100, (...args) => notices.push(args))
  try {
    const room = await client.consumeSeatReservation(seat, FrontierState)
    const pending = waitForPlayer(room, client.signal)
    const socket = await fixture.peer
    socket.close(TOWN_CLOSE_REPLACED, 'Joined from somewhere else.')
    await expect(pending).rejects.toThrow('Joined from somewhere else.')
    expect(notices).toEqual([['closed', 'Joined from somewhere else.', TOWN_CLOSE_REPLACED]])
    expect(() => client.attach({ control: () => undefined, events: () => undefined })).toThrow(
      'Joined from somewhere else.',
    )
  } finally {
    client.release()
    await fixture.server.stop(true)
  }
})
