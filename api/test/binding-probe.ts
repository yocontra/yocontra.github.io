/** Exercise production room methods with the delayed-close state that Colyseus can retain. */
import { ClientState, getMessageBytes, Protocol } from '@colyseus/core'
import { createNativeRoom } from '../src/game/room.ts'
import { CloudflareClient } from '../src/game/socket.ts'
import { LobbyCore, type Peer, type Session } from '../src/town/core.ts'

export async function bindingProbe(id: string) {
  const core = new LobbyCore(id, 7)
  core.ambientPopulation = 0
  let controls = 0
  let departures = 0
  let empty = 0
  let joinBarrier: Promise<void> = Promise.resolve()
  const room = await createNativeRoom({
    id,
    core,
    onTick: () => undefined,
    onJoin: () => joinBarrier,
    onControl: () => {
      controls++
    },
    onEmpty: () => {
      empty++
    },
    onLeave: () => {
      departures++
    },
  })
  const profile = (accountId: string) => ({
    accountId,
    name: accountId,
    level: 1,
    prestige: 0,
    loadout: [],
    banked: 0,
    tcpRtt: null,
    ledger: false,
  })
  const peer = (): Peer => ({ send: () => undefined, close: () => undefined })
  const fakeClient = (name: string) => {
    const client = new CloudflareClient(name, {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
    } as unknown as WebSocket)
    client.state = ClientState.JOINED
    return client
  }
  let pongs = 0
  const links = Reflect.get(room, 'links') as Map<string, { pong: () => void }>
  const sessions = Reflect.get(room, 'sessions') as Map<string, Session>
  const peers = Reflect.get(room, 'peers') as Map<string, Peer>
  const oldPeer = peer()
  const old = core.join(profile('old'), oldPeer, Date.now())
  if (!old) {
    throw new Error('Missing old session')
  }
  sessions.set('old', old)
  peers.set('old', oldPeer)
  core.disconnect(old.playerId, oldPeer)
  const gone = core.world.players[old.playerId]
  if (!gone) {
    throw new Error('Missing retiring player')
  }
  gone.gone = true
  core.tick(Date.now())
  const newPeer = peer()
  const current = core.join(profile('new'), newPeer, Date.now())
  if (!current || current.playerId !== old.playerId) {
    throw new Error('Probe did not reuse player slot')
  }
  sessions.set('new', current)
  peers.set('new', newPeer)
  const staleFrame = { seq: 99, moveX: 1, moveZ: 0, yaw: 0, pitch: 0, buttons: 1, viewTime: 0 }
  Reflect.set(room, 'inputs', {
    get: (name: string) => ({ next: () => (name === 'old' ? staleFrame : undefined) }),
  })
  room.advance()
  const player = core.world.players[current.playerId]
  if (!player || player.lastSeq === 99 || player.ammo !== 6) {
    throw new Error('Retired socket controlled reused slot')
  }
  const dispatch = (name: string, type: string) => {
    Reflect.get(room, '_onMessage').call(
      room,
      fakeClient(name),
      getMessageBytes.raw(Protocol.ROOM_DATA, type, {}),
    )
  }
  links.set('old', {
    pong: () => {
      pongs++
    },
  })
  links.set('new', {
    pong: () => {
      pongs++
    },
  })
  dispatch('old', 'network-pong')
  dispatch('new', 'network-pong')
  dispatch('old', 'control')
  dispatch('new', 'control')
  if (
    controls !== 1 ||
    pongs !== 1 ||
    room.state.players.get(String(current.playerId))?.sessionId !== 'new'
  ) {
    throw new Error('Retired control or replicated session binding escaped guard')
  }
  room.onLeave(fakeClient('old'))
  if (current.peer !== newPeer || departures !== 0) {
    throw new Error('Retired leave disconnected reused slot')
  }
  // A same-account replacement shares its Session object, so object identity alone is insufficient.
  const newestPeer = peer()
  core.join(profile('new'), newestPeer, Date.now())
  sessions.set('newest', current)
  peers.set('newest', newestPeer)
  Reflect.set(room, 'inputs', {
    get: (name: string) => ({
      next: () => (name === 'new' ? staleFrame : { ...staleFrame, seq: 7, buttons: 0 }),
    }),
  })
  room.advance()
  links.set('newest', {
    pong: () => {
      pongs++
    },
  })
  dispatch('new', 'network-pong')
  dispatch('newest', 'network-pong')
  dispatch('new', 'control')
  dispatch('newest', 'control')
  room.onLeave(fakeClient('new'))
  if (
    player.lastSeq !== 7 ||
    current.peer !== newestPeer ||
    Number(controls) !== 2 ||
    Number(pongs) !== 2 ||
    departures !== 0 ||
    room.state.players.get(String(current.playerId))?.sessionId !== 'newest'
  ) {
    throw new Error('Shared-session stale peer escaped guard')
  }
  // Production onJoin must retire stale maps before its persistence await completes.
  Reflect.set(room, 'setFixedTimestep', () => undefined)
  let releaseJoin: () => void = () => undefined
  joinBarrier = new Promise<void>((resolve) => {
    releaseJoin = resolve
  })
  const joining = room.onJoin(fakeClient('final'), { profile: profile('new'), protocol: 1 })
  const retired = !sessions.has('newest') && sessions.has('final')
  releaseJoin()
  await joining
  // Framework clients can retain old sockets until their asynchronous close completes.
  room.clients.push(fakeClient('retiring-framework-client'))
  room.onLeave(fakeClient('final'))
  if (empty !== 1 || core.connectedHumans() !== 0) {
    throw new Error('Retiring framework client prevented last-human cleanup')
  }
  room.clients.pop()
  await room.disconnect()
  if (!retired) {
    throw new Error('Replacement join retained an old authority binding')
  }
  return { reusedSlot: true, sameSessionProtected: true, retired, controls, departures }
}
