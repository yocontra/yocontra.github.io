import { Client, type Room } from '@colyseus/sdk'
import type { ServerControl } from '../contract/town.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { FrontierState, PlayerRecord } from '../runtime/schema.ts'
import type { ConnectionNotice } from './reconnect-session.ts'

interface RoomHandlers {
  control: (control: ServerControl) => void
  events: (events: readonly SimEvent[]) => void
}

export class FrontierRoomClient extends Client {
  private readonly startup = new AbortController()
  private onState: ConnectionNotice | undefined
  private handlers: RoomHandlers | undefined
  banked: number

  constructor(endpoint: string, banked: number, onState?: ConnectionNotice) {
    super(endpoint)
    this.banked = banked
    this.onState = onState
  }

  get signal(): AbortSignal {
    return this.startup.signal
  }

  /** The SDK calls this before opening the seat's transport. */
  protected override createRoom<T>(roomName: string, schema?: new () => T): Room<unknown, T> {
    const room = super.createRoom(roomName, schema)
    room.reconnection.enabled = false
    room.onMessage<{ nonce: string }>('network-ping', ({ nonce }) => {
      if (typeof nonce === 'string' && nonce.length <= 128) {
        room.send('network-pong', { nonce })
      }
    })
    room.onMessage<ServerControl>('control', (control) => {
      if (control.type === 'welcome' || control.type === 'deposit') {
        this.banked = control.banked
      }
      this.handlers?.control(control)
    })
    // Transient effects before the viewport is attached already have a durable snapshot.
    room.onMessage<{ tick: number; events: SimEvent[] }>('events', ({ events }) => {
      this.handlers?.events(events)
    })
    room.onLeave((code, reason) => {
      const onState = this.onState
      this.release()
      this.startup.abort(new Error(reason || 'Connection lost.'))
      onState?.('closed', reason, code)
    })
    return room
  }

  attach(handlers: RoomHandlers): void {
    this.signal.throwIfAborted()
    this.handlers = handlers
  }

  release(): void {
    this.handlers = undefined
    this.onState = undefined
  }
}

function ownPlayer(room: Room<unknown, FrontierState>): PlayerRecord | undefined {
  return [...room.state.players.values()].find((player) => player.sessionId === room.sessionId)
}

export function waitForPlayer(
  room: Room<unknown, FrontierState>,
  signal: AbortSignal,
): Promise<PlayerRecord> {
  signal.throwIfAborted()
  const ready = ownPlayer(room)
  if (ready) {
    return Promise.resolve(ready)
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      room.onStateChange.remove(change)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    const change = (): void => {
      const player = ownPlayer(room)
      if (player) {
        cleanup()
        resolve(player)
      }
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('The town did not send your player.'))
    }, 15_000)
    room.onStateChange(change)
    signal.addEventListener('abort', abort, { once: true })
  })
}
