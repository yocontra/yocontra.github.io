import process from 'node:process'
import { getMessageBytes, Protocol } from '@colyseus/core'
import { Encoder } from '@colyseus/schema'
import { serve } from 'bun'
import {
  CONTRACT_VERSION,
  TOWN_CLOSE_REPLACED,
} from '../../src/experiments/out-west/contract/town.ts'
import { FrontierState, PlayerRecord } from '../../src/experiments/out-west/runtime/schema.ts'

export const sessionId = 'rider'
export const roomEvent = { type: 'glass_break', window: 1 } as const
const earlyDeposit = {
  type: 'deposit',
  seq: 5,
  amount: 70,
  commission: 5,
  banked: 200,
  ok: true,
}
export const nextDeposit = { ...earlyDeposit, seq: 6, banked: 275 }

interface SocketState {
  room: 'wallet' | 'replacement'
  joined: boolean
}

if (import.meta.main) {
  const state = new FrontierState()
  const player = new PlayerRecord()
  player.id = '4'
  player.sessionId = sessionId
  state.players.set(player.id, player)
  const initialState = Uint8Array.of(Protocol.ROOM_STATE, ...new Encoder(state).encodeAll())
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
  const server = serve<SocketState>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, listener) {
      const room = new URL(req.url).pathname.split('/').at(-1)
      if (
        (room === 'wallet' || room === 'replacement') &&
        listener.upgrade(req, { data: { room, joined: false } })
      ) {
        return
      }
      return new Response('Expected WebSocket upgrade', { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.send(getMessageBytes[Protocol.JOIN_ROOM]('resume-token', 'schema'))
      },
      message(socket, data) {
        if (typeof data === 'string') {
          return
        }
        if (data[0] === Protocol.JOIN_ROOM) {
          socket.data.joined = true
          if (socket.data.room === 'wallet') {
            socket.send(getMessageBytes.raw(Protocol.ROOM_DATA, 'control', welcome))
            socket.send(getMessageBytes.raw(Protocol.ROOM_DATA, 'control', earlyDeposit))
            socket.send(
              getMessageBytes.raw(Protocol.ROOM_DATA, 'events', { tick: 22, events: [roomEvent] }),
            )
            socket.send(initialState)
          }
        } else if (data[0] === Protocol.LEAVE_ROOM) {
          socket.close()
        } else if (data[0] === Protocol.ROOM_DATA && socket.data.joined) {
          if (socket.data.room === 'replacement') {
            socket.close(TOWN_CLOSE_REPLACED, 'Joined from somewhere else.')
          } else {
            socket.send(
              getMessageBytes.raw(Protocol.ROOM_DATA, 'events', { tick: 30, events: [roomEvent] }),
            )
            socket.send(getMessageBytes.raw(Protocol.ROOM_DATA, 'control', nextDeposit))
          }
        }
      },
    },
  })
  process.stdout.write(`${server.url}\n`)
}
