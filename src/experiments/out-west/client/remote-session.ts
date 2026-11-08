import { Client, Predict, type Room, type SeatReservation } from '@colyseus/sdk'
import { type Entity, Vec3 } from 'playcanvas'
import { COLLISION_VERSION } from '../content/manifest.ts'
import { type ServerControl, TOWN_WIRE_VERSION } from '../contract/town.ts'
import { createWorld } from '../ffa/sim/state.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import { makeMoveState } from '../ffa/sim/types.ts'
import { API_URL, getAccessToken } from '../net/auth.ts'
import { pageTurnstile } from '../net/turnstile.ts'
import { loadAmmo } from '../runtime/ammo.ts'
import { batchInputs } from '../runtime/packets.ts'
import {
  Buttons,
  type CollisionData,
  type PlayerState,
  PROTOCOL_VERSION,
} from '../runtime/protocol.ts'
import { FrontierState, MoveInput, type PlayerRecord } from '../runtime/schema.ts'
import { createSimulation } from '../runtime/world.ts'
import type { Appearance } from './actors.ts'
import type { FrontierSession } from './frontier-session.ts'
import { reconnectableSession } from './reconnect-session.ts'
import { ShowdownInput } from './showdown-input.ts'
import { applyFrontierState } from './state.ts'

interface JoinResponse {
  reservation: SeatReservation
  lobbyId: string
  wsUrl: string
  banked: number
}
export interface RemoteSessionOptions {
  apiUrl?: string
  lobbyId?: string
  getToken?: () => Promise<string | null>
  onState?: (state: 'open' | 'retrying' | 'closed', reason?: string) => void
  onControl?: (control: ServerControl) => void
}

async function reserve(options: RemoteSessionOptions): Promise<JoinResponse> {
  const token = await (options.getToken ?? getAccessToken)()
  if (!token) {
    throw new Error('Sign in to play Frontier.')
  }
  const turnstileToken = await pageTurnstile().take()
  if (!turnstileToken) {
    throw new Error('Could not verify this device. Try again.')
  }
  const response = await fetch(`${options.apiUrl ?? API_URL}/town/native/join`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      wire: TOWN_WIRE_VERSION,
      protocol: PROTOCOL_VERSION,
      collision: COLLISION_VERSION,
      turnstileToken,
      ...(options.lobbyId ? { lobbyId: options.lobbyId } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const value = (await response.json()) as JoinResponse & { error?: string; reason?: string }
  if (!response.ok) {
    throw new Error(value.error ?? value.reason ?? 'Could not join Frontier.')
  }
  if (!(value.reservation && value.lobbyId && value.wsUrl)) {
    throw new Error('The server returned an invalid reservation.')
  }
  return value
}

function ownPlayer(room: Room<unknown, FrontierState>): PlayerRecord | undefined {
  return [...room.state.players.values()].find((player) => player.sessionId === room.sessionId)
}
function waitForPlayer(room: Room<unknown, FrontierState>): Promise<PlayerRecord> {
  const ready = ownPlayer(room)
  if (ready) {
    return Promise.resolve(ready)
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      room.onStateChange.remove(change)
      reject(new Error('The town did not send your player.'))
    }, 15_000)
    const change = (): void => {
      const player = ownPlayer(room)
      if (player) {
        clearTimeout(timeout)
        room.onStateChange.remove(change)
        resolve(player)
      }
    }
    room.onStateChange(change)
  })
}

/** Colyseus owns prediction/reconciliation; the adapter supplies the native motor and pose. */
export function createRemoteFrontierSession(
  collision: CollisionData,
  options: RemoteSessionOptions = {},
): Promise<FrontierSession> {
  return reconnectableSession(
    (onState) => connectOnce(collision, { ...options, onState }),
    options.onState,
  )
}
async function connectOnce(
  collision: CollisionData,
  options: RemoteSessionOptions,
): Promise<FrontierSession> {
  const reservation = await reserve(options)
  const query = new URL(reservation.wsUrl).searchParams.toString()
  const client = new Client(`${options.apiUrl ?? API_URL}/town/${reservation.lobbyId}?${query}`)
  const room: Room<unknown, FrontierState> = await client.consumeSeatReservation(
    reservation.reservation,
    FrontierState,
  )
  room.onMessage<{ nonce: string }>('network-ping', (message) => {
    if (typeof message.nonce === 'string' && message.nonce.length <= 128) {
      room.send('network-pong', { nonce: message.nonce })
    }
  })
  room.reconnection.enabled = false
  let prediction: ReturnType<typeof createSimulation> | undefined
  try {
    const self = await waitForPlayer(room)
    if (room.state.protocol !== PROTOCOL_VERSION || room.state.content !== COLLISION_VERSION) {
      throw new Error('The town was updated. Reload the page to play.')
    }
    prediction = createSimulation({ ammo: await loadAmmo(), collision })
    return connectSession(room, self, prediction, {
      ...options,
      initialBanked: reservation.banked,
    })
  } catch (error) {
    prediction?.dispose()
    void room.leave()
    throw error
  }
}

function connectSession(
  room: Room<unknown, FrontierState>,
  self: PlayerRecord,
  physics: ReturnType<typeof createSimulation>,
  options: RemoteSessionOptions & { initialBanked: number },
): FrontierSession {
  const world = createWorld()
  const selfId = self.id
  const selfSlot = Number(selfId)
  const poses = new Map<string, PlayerState>()
  const appearances = new Map<string, Appearance>()
  const listeners = new Set<(event: SimEvent) => void>()
  const controls = new Set<(control: ServerControl) => void>()
  let banked = options.initialBanked
  let disposed = false
  const packets = batchInputs(room.connection)
  let lastButtons = 0
  physics.addPlayer(selfId, [self.x, self.y + 0.9, self.z])
  const predict = Predict.get(room, { mode: 'lerp', delay: 100 })
  predict.attachAll('players', { mode: 'lerp', fields: ['x', 'y', 'z', 'yaw'] })
  const input = room.input({ type: MoveInput, mode: 'reliable' })
  const showdownInput = new ShowdownInput({
    world,
    self: selfSlot,
    send: (text) => room.send('control', JSON.parse(text)),
  })
  const mine = predict.sim({
    input,
    world: { physics },
    step: (_context, local, command) => local.physics.step(new Map([[selfId, command]])),
    adopt: (local) => {
      const previous = local.physics.players.get(selfId)
      if (previous) {
        local.physics.adopt(selfId, {
          ...previous,
          x: self.x,
          y: self.y + 0.9,
          z: self.z,
          vx: self.vx,
          vy: self.vy,
          vz: self.vz,
          yaw: self.yaw,
          pitch: ((self.pitch / 127) * Math.PI) / 2,
          seq: self.seq,
          grounded: self.grounded,
          hp: self.hp,
          ammo: self.ammo,
          motion: {
            ...makeMoveState(self.x, self.z),
            ...self.motion.toJSON(),
            x: self.x,
            y: self.y,
            z: self.z,
            vy: self.vy,
            grounded: self.grounded,
          },
        })
      }
    },
    pose: (local) => {
      const player = local.physics.players.get(selfId)
      return {
        x: player?.x ?? self.x,
        y: (player?.y ?? self.y + 0.9) - 0.9,
        z: player?.z ?? self.z,
      }
    },
    smoothMs: 90,
  })
  const sync = (): void => applyFrontierState(room.state, world, poses, appearances)
  room.onStateChange(sync)
  sync()
  room.onMessage<{ tick: number; events: SimEvent[] }>('events', (message) => {
    for (const event of message.events) {
      for (const listener of listeners) {
        listener(event)
      }
    }
  })
  room.onMessage<ServerControl>('control', (control) => {
    showdownInput.control(control)
    if (control.type === 'deposit') {
      banked = control.banked
    }
    options.onControl?.(control)
    for (const listener of controls) {
      listener(control)
    }
  })
  room.onDrop(() => options.onState?.('retrying'))
  room.onReconnect(() => options.onState?.('open'))
  room.onLeave((_code, reason) => {
    if (!disposed) {
      options.onState?.('closed', reason)
    }
  })
  options.onState?.('open')
  return {
    selfId,
    selfSlot,
    practice: false,
    lobbyId: room.roomId,
    control(text) {
      room.send('control', JSON.parse(text))
    },
    subscribeControl(listener) {
      controls.add(listener)
      return () => controls.delete(listener)
    },
    world,
    players: poses,
    appearance: (id) => appearances.get(id),
    get banked() {
      return banked
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(_dt, intent) {
      if (disposed) {
        return
      }
      showdownInput.sample(intent)
      const due = Math.min(4, predict.tick(performance.now()))
      for (let i = 0; i < due; i++) {
        Object.assign(input.data, intent, { viewTime: world.tick - 2 })
        input.send()
        const edge = intent.buttons & ~lastButtons
        if (
          edge &
          (Buttons.fire |
            Buttons.jump |
            Buttons.roll |
            Buttons.interact |
            Buttons.throw |
            Buttons.callout)
        ) {
          packets.flush()
        }
        lastButtons = intent.buttons
      }
      poses.clear()
      for (const record of room.state.players.values()) {
        const own = record.id === selfId
        poses.set(record.id, {
          id: record.id,
          x: own ? mine.value('x') : predict.value(record, 'x'),
          y: (own ? mine.value('y') : predict.value(record, 'y')) + 0.9,
          z: own ? mine.value('z') : predict.value(record, 'z'),
          vx: record.vx,
          vy: record.vy,
          vz: record.vz,
          yaw: record.yaw,
          pitch: ((record.pitch / 127) * Math.PI) / 2,
          grounded: record.grounded,
          hp: record.hp,
          ammo: record.ammo,
          seq: record.seq,
        })
      }
    },
    cameraTrace(from, to) {
      const hit = physics.app.systems.rigidbody?.raycastFirst(from, to, {
        filterCallback: (entity: Entity) => entity.name !== selfId,
      })
      return hit ? new Vec3(hit.point.x, hit.point.y, hit.point.z) : null
    },
    dispose() {
      if (!disposed) {
        disposed = true
        listeners.clear()
        controls.clear()
        packets.dispose()
        predict.dispose()
        physics.dispose()
        void room.leave()
      }
    },
  }
}
