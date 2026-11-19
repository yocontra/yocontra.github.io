import { DurableObject } from 'cloudflare:workers'
import {
  connectClientToRoom,
  createAuthContext,
  LocalDriver,
  LocalPresence,
  matchMaker,
} from '@colyseus/core'
import { DurableSeats } from 'durable-game-runtime/seats'
import { CloudflareClient } from 'durable-game-runtime/transport'
import { MAX_CLIENTS, PhysicsRoom, ROOM_NAME } from './physics-room.ts'

const VALID_NAME = /^[a-z0-9-]{1,40}$/u
const SOCKET_PATH = /^\/native\/(?<roomId>[0-9a-f]{64})$/u

let setup: Promise<unknown> | undefined
function setupMatchmaking() {
  setup ??= matchMaker.setup(new LocalPresence(), new LocalDriver()).then(() => {
    matchMaker.defineRoomType(ROOM_NAME, PhysicsRoom)
  })
  return setup
}

interface ExampleEnv {
  ROOMS: DurableObjectNamespace<ExampleRoom>
}
interface DemoSeat {
  lobbyId: string
  profile: { accountId: string }
}
export class ExampleRoom extends DurableObject<ExampleEnv> {
  private readonly seats = new DurableSeats<DemoSeat>(this.ctx.storage, {
    name: ROOM_NAME,
    processId: 'native',
    clients: 0,
    maxClients: MAX_CLIENTS,
  })
  private readonly clients = new Map<WebSocket, CloudflareClient>()
  private pendingRoom: Promise<PhysicsRoom> | undefined
  private get roomId() {
    return this.ctx.id.toString()
  }

  override async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/status') {
      const room = matchMaker.getLocalRoomById(this.roomId) as PhysicsRoom | undefined
      return Response.json({ active: room?.active ?? false })
    }
    // Local demo identity. A public Worker must derive this id from verified authentication.
    const accountId = url.searchParams.get('player')
    if (!(accountId && VALID_NAME.test(accountId))) {
      return new Response('Player required', { status: 400 })
    }
    if (url.pathname === '/reserve' && request.method === 'POST') {
      const seat = this.seats.issue(this.roomId, {
        lobbyId: this.roomId,
        profile: { accountId },
      })
      await this.scheduleExpiry()
      return Response.json(seat)
    }
    const sessionId = url.searchParams.get('sessionId')
    if (
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
      !sessionId ||
      !this.seats.consume(sessionId, accountId, this.roomId)
    ) {
      return new Response('Valid unconsumed seat required', { status: 409 })
    }
    await this.scheduleExpiry()
    const room = await this.getRoom()
    const listing = await matchMaker.driver.findOne({ roomId: this.roomId })
    try {
      await matchMaker.reserveSeatFor(listing, {}, { sessionId })
    } catch {
      return new Response('Room unavailable', { status: 409 })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    const client = new CloudflareClient(sessionId, server)
    this.ctx.acceptWebSocket(server)
    this.clients.set(server, client)
    this.ctx.waitUntil(
      connectClientToRoom(room, client, createAuthContext({ headers: request.headers }), {}).catch(
        () => {
          this.clients.delete(server)
          server.close(4001, 'Join failed')
        },
      ),
    )
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private async getRoom(): Promise<PhysicsRoom> {
    await setupMatchmaking()
    const current = matchMaker.getLocalRoomById(this.roomId) as PhysicsRoom | undefined
    if (current) {
      return current
    }
    this.pendingRoom ??= matchMaker
      .handleCreateRoom(ROOM_NAME, {}, undefined, this.roomId)
      .then(() => matchMaker.getLocalRoomById(this.roomId) as PhysicsRoom)
      .finally(() => {
        this.pendingRoom = undefined
      })
    return this.pendingRoom
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const client = this.clients.get(socket)
    if (client) {
      client.dispatch(message)
    } else {
      socket.close(1012, 'Room restarted')
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.clients.get(socket)?.disconnected(code, reason)
    this.clients.delete(socket)
  }

  override webSocketError(socket: WebSocket) {
    this.webSocketClose(socket, 1011, 'Socket error')
  }

  override async alarm() {
    this.seats.expire()
    await this.scheduleExpiry()
  }

  private async scheduleExpiry() {
    const expiry = this.seats.nextExpiry()
    if (expiry === undefined) {
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(expiry)
    }
  }
}

export default {
  fetch(request: Request, env: ExampleEnv) {
    const url = new URL(request.url)
    const roomId = SOCKET_PATH.exec(url.pathname)?.groups?.roomId
    if (!roomId && url.pathname !== '/reserve' && url.pathname !== '/status') {
      return new Response('Not found', { status: 404 })
    }
    const name = url.searchParams.get('room')
    if (!(roomId || (name && VALID_NAME.test(name)))) {
      return new Response('Room required', { status: 400 })
    }
    const id = roomId ? env.ROOMS.idFromString(roomId) : env.ROOMS.idFromName(name ?? '')
    return env.ROOMS.get(id).fetch(request)
  },
} satisfies ExportedHandler<ExampleEnv>
