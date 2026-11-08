import {
  type AuthContext,
  type Client,
  LocalDriver,
  LocalPresence,
  matchMaker,
  Room,
} from '@colyseus/core'
import physicsModule from '../../../public/experiments/out-west/physics/ammo.wasm.wasm'
import { ANGLE_SCALE } from '../../../src/experiments/out-west/contract/town.ts'
import { activePlayers } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { initializeAmmo } from '../../../src/experiments/out-west/runtime/ammo.ts'
import { COLLISION as collision } from '../../../src/experiments/out-west/runtime/collision.ts'
import { createFrontierSimulation } from '../../../src/experiments/out-west/runtime/frontier.ts'
import { PROTOCOL_VERSION } from '../../../src/experiments/out-west/runtime/protocol.ts'
import {
  FrontierState,
  MoveInput,
  PlayerRecord,
} from '../../../src/experiments/out-west/runtime/schema.ts'
import type { JoinProfile, LobbyCore, Session, TickOutput } from '../town/core.ts'
import { FixedRoomClock } from './clock.ts'
import callbackModule from './physics-callback.wasm'
import { GameLinkSampler } from './rtt.ts'

export interface NativeJoinProfile extends JoinProfile {
  appearance?: unknown
}
interface CreationOptions {
  id: string
  core: LobbyCore
  onTick: (output: TickOutput) => void
  onJoin?: (session: Session) => Promise<void>
  onLeave?: (session: Session) => void
  onEmpty?: () => void
  onControl?: (session: Session, text: string, gameNow: number) => void
}
/** Each Durable Object owns its Room and world; the isolate registry only indexes room IDs. */
export class NativeFrontierRoom extends Room<{ state: FrontierState; input: MoveInput }> {
  override state = new FrontierState()
  override inputs = this.defineInput(MoveInput, {
    bufferMaxSize: 8,
    sanitize: {
      moveX: [-1, 1],
      moveZ: [-1, 1],
      yaw: [-1_000_000, 1_000_000],
      viewTime: [0, 1_000_000_000_000],
      pitch: [-Math.PI / 2, Math.PI / 2],
      buttons: [0, 2047],
    },
    idle: ({ latest }) => latest ?? true,
  })
  private simulation: ReturnType<typeof createFrontierSimulation> | undefined
  private core: LobbyCore | undefined
  private readonly appearances = new Map<number, unknown>()
  private readonly sessions = new Map<string, Session>()
  private readonly links = new Map<string, GameLinkSampler>()
  private readonly peers = new Map<
    string,
    { send: (data: Uint8Array | string) => void; close: (code: number, reason: string) => void }
  >()
  private gameTime = Date.now()
  private creation: CreationOptions | undefined
  private onTick: ((output: TickOutput) => void) | undefined
  private started = false
  override async onCreate(options: CreationOptions) {
    this.creation = options
    this.roomId = options.id
    this.maxClients = 32
    this.autoDispose = false
    this.setPatchRate(null)
    // Workers clocks only advance on observable I/O. The fixed timer owns logical time;
    // quiet clients must not pause the match or receive stale state.
    this.clock.stop()
    this.clock = new FixedRoomClock()
    this.maxMessagesPerSecond = 30
    this.core = options.core
    this.onTick = options.onTick
    this.simulation = createFrontierSimulation({
      ammo: await initializeAmmo(physicsModule, callbackModule),
      collision,
      seed: options.core.world.seed,
    })
    this.core.world = this.simulation.world
    this.state.content = collision.version
    this.state.protocol = PROTOCOL_VERSION
    this.onMessage('control', (client, message: unknown) => {
      const session = this.currentSession(client.sessionId)
      if (!session) {
        return
      }
      const text = JSON.stringify(message)
      if (text.length > 4096) {
        client.leave(1009, 'Message too large')
        return
      }
      options.onControl?.(session, text, Math.max(Date.now(), this.gameTime))
    })
    this.onMessage('network-pong', (client, message: unknown) => {
      if (this.currentSession(client.sessionId)) {
        this.links.get(client.sessionId)?.pong(message, Date.now())
      }
    })
  }
  override onAuth(_client: Client, options: { profile: NativeJoinProfile }, context: AuthContext) {
    const transport = context.headers.get('X-Tcp-Rtt')
    const tcp = Number(transport)
    options.profile.tcpRtt =
      transport !== null && transport !== '' && Number.isFinite(tcp) && tcp >= 0 ? tcp : null
    return options.profile.accountId === context.headers.get('X-Account-Id')
  }
  override async onJoin(client: Client, options: { profile: NativeJoinProfile; protocol: number }) {
    if (options.protocol !== PROTOCOL_VERSION) {
      throw new Error('Refresh the game to join this room')
    }
    if (!this.core) {
      throw new Error('Room unavailable')
    }
    const peer = {
      send: (data: Uint8Array | string) => {
        if (typeof data === 'string') {
          client.send('control', JSON.parse(data))
        }
      },
      close: (code: number, reason: string) => client.leave(code, reason),
    }
    const session = this.core.join(options.profile, peer, Date.now())
    if (!session) {
      throw new Error('Room full')
    }
    // Replacement closes asynchronously; retire its authority before awaiting persistence.
    for (const [id, previous] of this.sessions) {
      if (previous.playerId === session.playerId) {
        this.forgetBinding(id)
      }
    }
    this.appearances.set(session.playerId, options.profile.appearance)
    this.sessions.set(client.sessionId, session)
    this.peers.set(client.sessionId, peer)
    await this.creation?.onJoin?.(session)
    if (this.currentSession(client.sessionId) !== session) {
      return
    }
    const link = new GameLinkSampler(session.rtt, (nonce) => client.send('network-ping', { nonce }))
    this.links.set(client.sessionId, link)
    client.ref.on('activity', (now: number) => {
      if (this.currentSession(client.sessionId)) {
        link.activity(now)
      }
    })
    // biome-ignore lint/suspicious/noUnnecessaryConditions: concurrent joins await persistence before reaching this guard
    if (!this.started) {
      this.started = true
      this.setFixedTimestep(() => this.advance(), 20, { subSteps: 3 })
    }
    this.replicate()
  }
  advance() {
    const core = this.core
    if (!core) {
      return
    }
    const frames: (InputFrame | null)[] = []
    for (const [sessionId, session] of this.sessions) {
      if (this.currentSession(sessionId) !== session) {
        continue
      }
      const input = this.inputs.get(sessionId).next()
      if (!input) {
        continue
      }
      const turn = (-input.yaw - Math.PI / 2) / (Math.PI * 2)
      frames[session.playerId] = {
        seq: input.seq,
        moveX: Math.round(input.moveX * 127),
        moveZ: Math.round(input.moveZ * 127),
        aim: Math.round((turn - Math.floor(turn)) * ANGLE_SCALE) % ANGLE_SCALE,
        pitch: Math.round((input.pitch / (Math.PI / 2)) * 127),
        buttons: input.buttons,
        viewTime: input.viewTime,
      }
    }
    this.gameTime = Math.max(Date.now(), this.gameTime + 50)
    const output = core.tick(this.gameTime, { frames })
    // Persist economic intent before any outgoing state/event bytes from this callback.
    this.onTick?.(output)
    this.replicate()
    if (core.world.events.length > 0) {
      this.broadcast('events', { tick: core.world.tick, events: core.world.events })
    }
    this.broadcastPatch()
  }
  private replicate() {
    const world = this.core?.world
    if (!world) {
      return
    }
    const present = new Set<string>()
    for (const player of activePlayers(world)) {
      const id = String(player.id)
      present.add(id)
      let record = this.state.players.get(id)
      if (!record) {
        record = new PlayerRecord()
        this.state.players.set(id, record)
      }
      for (const [key, value] of Object.entries(player)) {
        if (
          key !== 'id' &&
          key !== 'accountId' &&
          (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
        ) {
          Reflect.set(Reflect.has(record.motion, key) ? record.motion : record, key, value)
        }
      }
      const pose = this.simulation?.physics.players.get(id)
      record.sessionId =
        [...this.sessions].find(
          ([sessionId, session]) =>
            String(session.playerId) === id && this.currentSession(sessionId) === session,
        )?.[0] ?? ''
      record.id = id
      record.vx = pose?.vx ?? 0
      record.vz = pose?.vz ?? 0
      record.yaw = pose?.yaw ?? 0
      record.seq = player.lastSeq
      record.details = JSON.stringify({
        stats: player.stats,
        channel: player.channel,
        appearance: player.bot ? undefined : this.appearances.get(player.id),
      })
    }
    for (const id of this.state.players.keys()) {
      if (!present.has(id)) {
        this.state.players.delete(id)
      }
    }
    this.state.tick = world.tick
    this.state.game = JSON.stringify({
      bags: world.bags,
      strongbox: world.strongbox,
      pickups: world.pickups,
      fuses: world.fuses,
      showdowns: [...world.showdowns],
      mostWanted: world.mostWanted,
      glass: [...world.glass],
    })
  }
  private currentSession(id: string): Session | undefined {
    const session = this.sessions.get(id)
    const peer = this.peers.get(id)
    return session &&
      peer &&
      this.core?.sessionOf(session.playerId) === session &&
      session.peer === peer
      ? session
      : undefined
  }
  private forgetBinding(id: string) {
    this.sessions.delete(id)
    this.links.delete(id)
    this.peers.delete(id)
    this.clients.find((client) => client.sessionId === id)?.ref.removeAllListeners('activity')
  }
  override onLeave(client: Client) {
    const session = this.currentSession(client.sessionId)
    const peer = this.peers.get(client.sessionId)
    if (session && peer) {
      this.core?.disconnect(session.playerId, peer)
    }
    if (session && this.core?.sessionOf(session.playerId) === session && !session.peer) {
      this.creation?.onLeave?.(session)
    }
    this.forgetBinding(client.sessionId)
    client.ref.removeAllListeners('activity')
    if (this.core?.connectedHumans() === 0) {
      this.creation?.onEmpty?.()
    }
  }
  override onDispose() {
    this.simulation?.dispose()
    this.simulation = undefined
    this.sessions.clear()
    this.peers.clear()
    this.appearances.clear()
    this.links.clear()
  }
}
let initialized: Promise<void> | undefined
/** A stable isolate runtime; never swap process-wide configuration between requests. */
export async function createNativeRoom(options: CreationOptions): Promise<NativeFrontierRoom> {
  initialized ??= matchMaker.setup(new LocalPresence(), new LocalDriver()).then(() => {
    matchMaker.defineRoomType('frontier', NativeFrontierRoom)
  })
  await initialized
  await matchMaker.handleCreateRoom('frontier', options, undefined, options.id)
  return matchMaker.getLocalRoomById(options.id) as NativeFrontierRoom
}

export async function reserveNativeRoom(
  room: NativeFrontierRoom,
  profile: NativeJoinProfile,
  protocol: number,
) {
  const result = await matchMaker.joinById(room.roomId, { profile, protocol })
  return { ...result, processId: 'native' }
}
