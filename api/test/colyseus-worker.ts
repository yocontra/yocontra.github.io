import { DurableObject } from 'cloudflare:workers'
import { connectClientToRoom, createAuthContext } from '@colyseus/core'
import type { GraphicsDevice } from 'playcanvas'
import {
  TUMBLEWEED_ROUTES,
  tumbleweedCenter,
} from '../../src/experiments/out-west/contract/tumbleweed-motion.ts'
import { eyeHeight } from '../../src/experiments/out-west/ffa/sim/combat.ts'
import type { World } from '../../src/experiments/out-west/ffa/sim/state.ts'
import type { SimEvent } from '../../src/experiments/out-west/ffa/sim/types.ts'
import type { createFrontierSimulation } from '../../src/experiments/out-west/runtime/frontier.ts'
import { PROTOCOL_VERSION } from '../../src/experiments/out-west/runtime/protocol.ts'
import { AdmissionLeases } from '../src/game/admission.ts'
import { createNativeRoom, type NativeFrontierRoom, reserveNativeRoom } from '../src/game/room.ts'
import { CloudflareClient } from '../src/game/socket.ts'
import { LobbyCore } from '../src/town/core.ts'
import { bindingProbe } from './binding-probe.ts'
import { clockProbe } from './clock-probe.ts'
import { seatsProbe } from './seats-probe.ts'

function setupBucket(world: World | undefined): Response {
  const player = world?.players.find((candidate) => candidate && !candidate.bot)
  const bucket = world?.layout.cover[250]
  if (!(world && player && bucket?.kind === 'bucket')) {
    return new Response('A joined player and native bucket are required', { status: 400 })
  }
  const z = bucket.z + bucket.d / 2
  const pitch = ((-35 / 127) * Math.PI) / 2
  Object.assign(player, {
    x: bucket.x + bucket.w / 2 + 1.9,
    y: 0,
    z,
    ammo: 6,
    protectUntil: 0,
    spawnTick: -10_000,
    fireCooldownMs: 0,
    lastButtons: 0,
  })
  return Response.json({ tick: world.tick, pitch, cover: 250 })
}

interface TestEnv {
  ROOMS: DurableObjectNamespace<TestRoom>
}
export class TestRoom extends DurableObject<TestEnv> {
  private room: NativeFrontierRoom | undefined
  private core: LobbyCore | undefined
  private environmentDevice: GraphicsDevice | undefined
  private readonly environmentEvents: SimEvent[] = []
  private readonly clients = new Map<WebSocket, CloudflareClient>()
  override async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/seats') {
      return Response.json(seatsProbe(this.ctx.storage))
    }
    if (url.pathname === '/clock') {
      return Response.json(await clockProbe())
    }
    if (url.pathname === '/timing') {
      return Response.json({
        tick: this.room?.state.tick ?? 0,
        elapsed: this.room?.clock.elapsedTime,
        running: this.room?.clock.running,
        timer: this.room?.running ?? false,
        physics: Boolean(this.room && Reflect.get(this.room, 'simulation')),
      })
    }
    if (url.pathname === '/dispose') {
      await this.room?.disconnect()
      return Response.json({ disposed: true })
    }
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
      this.core = core
      this.room = await createNativeRoom({
        id: this.ctx.id.toString(),
        core,
        onTick: () => {
          this.environmentEvents.push(
            ...core.world.events.filter(
              (event) => event.type === 'shot' || event.type === 'prop_break',
            ),
          )
          this.environmentEvents.splice(0, Math.max(0, this.environmentEvents.length - 16))
        },
        ...(url.searchParams.has('holdStart')
          ? {
              onStart: async () => {
                await this.env.ROOMS.get(this.env.ROOMS.idFromName('join-barrier')).joinBarrier(500)
              },
            }
          : {}),
        onJoin: async () => {
          await this.env.ROOMS.get(this.env.ROOMS.idFromName('join-barrier')).joinBarrier()
        },
        onEmpty: () => {
          this.ctx.waitUntil(this.room?.disconnect() ?? Promise.resolve())
        },
      })
    }
    if (url.pathname.startsWith('/environment/')) {
      return this.environmentProbe(url.pathname, this.room)
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
          Number(url.searchParams.get('protocol') ?? PROTOCOL_VERSION),
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
    this.ctx.waitUntil(
      connectClientToRoom(this.room, client, createAuthContext({ headers }), {}).catch(
        (error: unknown) => {
          server.close(4001, error instanceof Error ? error.message : 'Join failed')
        },
      ),
    )
    return new Response(null, { status: 101, webSocket: pair[0] })
  }
  private environmentProbe(path: string, room: NativeFrontierRoom) {
    const world = this.core?.world
    const simulation = Reflect.get(room, 'simulation') as
      | ReturnType<typeof createFrontierSimulation>
      | undefined
    if (simulation) {
      this.environmentDevice = simulation.physics.app.graphicsDevice
    }
    if (path === '/environment/setup-bucket') {
      return setupBucket(simulation ? world : undefined)
    }
    if (path === '/environment/setup-weed') {
      const player = world?.players.find((candidate) => candidate && !candidate.bot)
      if (!(world && player && simulation)) {
        return new Response('A joined player is required', { status: 400 })
      }
      const target = tumbleweedCenter(TUMBLEWEED_ROUTES[0], world.tick)
      Object.assign(player, {
        x: target.x - 3,
        y: 0,
        z: target.z,
        protectUntil: 0,
        spawnTick: -10_000,
        fireCooldownMs: 0,
        lastButtons: 0,
      })
      return Response.json({
        tick: world.tick,
        pitch: Math.atan2(target.y - eyeHeight({ crouched: true }), 3),
      })
    }
    if (path === '/environment/setup') {
      const players = world?.players.filter((player) => player && !player.bot) ?? []
      if (players.length !== 2 || !world || !simulation) {
        return new Response('Two joined players required', { status: 400 })
      }
      this.environmentDevice = simulation.physics.app.graphicsDevice
      for (const [i, player] of players.entries()) {
        if (player) {
          Object.assign(player, {
            x: i === 0 ? 26 : 29.8,
            y: 0,
            z: 66.25,
            hp: 100,
            protectUntil: 0,
            spawnTick: -10_000,
            fireCooldownMs: 0,
            lastButtons: 0,
          })
        }
      }
    }
    return Response.json({
      props: world ? [...world.props] : null,
      players: world?.players
        .filter((p) => p && !p.bot)
        .map(
          (p) =>
            p && {
              id: p.id,
              x: p.x,
              y: p.y,
              z: p.z,
              aim: p.aim,
              pitch: p.pitch,
              ammo: p.ammo,
              hp: p.hp,
              seq: p.lastSeq,
              crouched: p.crouched,
              cooldown: p.fireCooldownMs,
            },
        ),
      events: this.environmentEvents,
      running: room.running,
      physics: Boolean(simulation),
      buffers: this.environmentDevice?.buffers.size ?? null,
      textures: this.environmentDevice?.textures.size ?? null,
    })
  }
  async joinBarrier(delay = 50) {
    await new Promise((resolve) => setTimeout(resolve, delay))
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
