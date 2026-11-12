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
  onStart?: () => Promise<void>
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
  private started = false as boolean
  private closed = false as boolean
  private preparing: Promise<void> | undefined
  private readonly pendingJoins = new Set<string>()
  override onCreate(options: CreationOptions) {
    this.creation = options
    this.roomId = options.id
    this.maxClients = 32
    this.autoDispose = false
    // Workers clocks only advance on observable I/O. The fixed timer owns logical time;
    // quiet clients must not pause the match or receive stale state.
    this.clock.stop()
    this.clock = new FixedRoomClock()
    // Public SDK setters clear the initial patch timer without installing a clock-only timer.
    // setTimestep(undefined) then clears the temporary fixed timer; reserved seats own no interval.
    this.setFixedTimestep(() => undefined, 20, { subSteps: 3 })
    this.setPatchRate(null)
    this.setTimestep()
    this.clock.stop()
    // No Colyseus maxMessagesPerSecond: it windows on this tick-driven clock, so a stall replays a
    // queued backlog into one "second" and drops healthy players. CloudflareClient limits frames.
    this.core = options.core
    this.onTick = options.onTick
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
  private async prepareGame(): Promise<void> {
    if (this.simulation) {
      return
    }
    this.preparing ??= (async () => {
      await this.creation?.onStart?.()
      if (this.closed || this.pendingJoins.size === 0 || !this.core) {
        throw new DOMException('Town was closed', 'AbortError')
      }
      const ammo = await initializeAmmo(physicsModule, callbackModule)
      if (this.closed || this.pendingJoins.size === 0 || !this.core) {
        throw new DOMException('Town was closed', 'AbortError')
      }
      this.simulation = createFrontierSimulation({ ammo, collision, seed: this.core.world.seed })
      this.core.world = this.simulation.world
    })().catch((error) => {
      this.preparing = undefined
      throw error
    })
    await this.preparing
  }
  /** Stop native work synchronously; economic settlement and SDK socket disposal may finish later. */
  stopGameplay(): void {
    this.closed = true
    this.started = false
    this.pendingJoins.clear()
    this.setTimestep()
    this.clock.stop()
    this.simulation?.dispose()
    this.simulation = undefined
  }
  get running(): boolean {
    return this.started && !this.closed
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
    if (!this.core || this.closed || Reflect.get(client.ref, 'readyState') !== 1) {
      throw new Error('Room unavailable')
    }
    this.pendingJoins.add(client.sessionId)
    const earlyClose = () => {
      if (this.pendingJoins.has(client.sessionId)) {
        this.onLeave(client)
      }
    }
    client.ref.once('close', earlyClose)
    try {
      if (!this.simulation) {
        await this.prepareGame()
      }
      if (
        this.closed ||
        !this.pendingJoins.has(client.sessionId) ||
        Reflect.get(client.ref, 'readyState') !== 1
      ) {
        throw new DOMException('Socket was closed', 'AbortError')
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
      const link = new GameLinkSampler(session.rtt, (nonce) =>
        client.send('network-ping', { nonce }),
      )
      this.links.set(client.sessionId, link)
      client.ref.on('activity', (now: number) => {
        if (this.currentSession(client.sessionId)) {
          link.activity(now)
        }
      })
      this.pendingJoins.delete(client.sessionId)
      if (!this.started) {
        this.started = true
        this.clock.start()
        this.gameTime = Date.now()
        this.setFixedTimestep(() => this.advance(), 20, { subSteps: 3 })
      }
      this.replicate()
    } finally {
      client.ref.removeListener('close', earlyClose)
    }
  }

  advance() {
    const core = this.core
    if (!core || this.closed || core.connectedHumans() === 0) {
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
    this.pendingJoins.delete(client.sessionId)
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
    if (!this.closed && this.core?.connectedHumans() === 0 && this.pendingJoins.size === 0) {
      this.stopGameplay()
      this.creation?.onEmpty?.()
    }
  }
  override onDispose() {
    this.stopGameplay()
    this.sessions.clear()
    this.peers.clear()
    this.appearances.clear()
    this.links.clear()
    this.core = undefined
    this.creation = undefined
    this.onTick = undefined
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
  sessionId?: string,
) {
  const listing = sessionId ? await matchMaker.driver.findOne({ roomId: room.roomId }) : undefined
  if (sessionId && !listing) {
    throw new Error('Room expired')
  }
  const result = listing
    ? await matchMaker.reserveSeatFor(listing, { profile, protocol }, { sessionId })
    : await matchMaker.joinById(room.roomId, { profile, protocol })
  return { ...result, processId: 'native' }
}
