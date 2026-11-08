import { DurableObject } from 'cloudflare:workers'
import { connectClientToRoom, createAuthContext } from '@colyseus/core'
import { AdmissionLeases } from '../src/game/admission.ts'
import { createNativeRoom, type NativeFrontierRoom, reserveNativeRoom } from '../src/game/room.ts'
import { CloudflareClient } from '../src/game/socket.ts'
import { LobbyCore } from '../src/town/core.ts'
import { bindingProbe } from './binding-probe.ts'

interface TestEnv {
  ROOMS: DurableObjectNamespace<TestRoom>
}
export class TestRoom extends DurableObject<TestEnv> {
  private room: NativeFrontierRoom | undefined
  private readonly clients = new Map<WebSocket, CloudflareClient>()
  override async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/bindings') {
      return Response.json(await bindingProbe(`${this.ctx.id.toString()}-bindings`))
    }
    if (url.pathname === '/lease') {
      const body = (await request.json()) as {
        id: string
        messages?: number
        finish?: boolean
        now?: number
      }
      return Response.json(
        new AdmissionLeases(this.ctx.storage).renew(
          body.id,
          body.messages ?? 0,
          body.finish ?? false,
          body.now,
        ),
      )
    }
    if (!this.room) {
      const core = new LobbyCore(this.ctx.id.toString(), 7)
      core.ambientPopulation = 0
      this.room = await createNativeRoom({
        id: this.ctx.id.toString(),
        core,
        onTick: () => undefined,
        onJoin: async () => {
          await this.env.ROOMS.get(this.env.ROOMS.idFromName('join-barrier')).joinBarrier()
        },
        onEmpty: () => {
          this.ctx.waitUntil(this.room?.disconnect() ?? Promise.resolve())
        },
      })
    }
    if (url.pathname === '/reserve') {
      return Response.json(
        await reserveNativeRoom(
          this.room,
          {
            accountId: url.searchParams.get('account') ?? 'alice',
            name: 'Player',
            level: 1,
            prestige: 0,
            loadout: [],
            banked: 0,
            tcpRtt: null,
            ledger: false,
          },
          1,
        ),
      )
    }
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) {
      return new Response('Session required', { status: 400 })
    }
    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    const client = new CloudflareClient(sessionId, server)
    this.clients.set(server, client)
    const headers = new Headers(request.headers)
    headers.set('X-Account-Id', url.searchParams.get('account') ?? 'alice')
    try {
      await connectClientToRoom(this.room, client, createAuthContext({ headers }), {})
    } catch (error) {
      server.close(4001, error instanceof Error ? error.message : 'Join failed')
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }
  async joinBarrier() {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return this.ctx.id.toString()
  }
  override webSocketMessage(socket: WebSocket, message: ArrayBuffer | string) {
    this.clients.get(socket)?.dispatch(message)
  }
  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.clients.get(socket)?.disconnected(code, reason)
    this.clients.delete(socket)
  }
  override webSocketError(socket: WebSocket) {
    this.webSocketClose(socket, 1011, 'Socket error')
  }
}
export default {
  fetch(request: Request, env: TestEnv) {
    const url = new URL(request.url)
    const id = url.pathname.startsWith('/native/')
      ? env.ROOMS.idFromString(url.pathname.split('/')[2] ?? '')
      : env.ROOMS.idFromName(url.searchParams.get('room') ?? 'first')
    return env.ROOMS.get(id).fetch(request)
  },
}
