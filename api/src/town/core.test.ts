import { describe, expect, test as it } from 'bun:test'
import {
  BTN_CALLOUT,
  NONE,
  type ServerControl,
} from '../../../src/experiments/out-west/contract/town.ts'
import {
  MAX_FRONTIER_BOTS,
  MAX_PLAYERS,
  SOFT_CAP,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { calloutTarget, handleCallout } from '../../../src/experiments/out-west/ffa/sim/showdown.ts'
import { pairKey } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { CalloutBlocks } from './callout-blocks.ts'
import {
  DEFAULT_TOWN_POPULATION,
  type JoinProfile,
  LobbyCore,
  type Peer,
  type SettledDeposit,
} from './core.ts'
import { serviceZone } from './testing/map-fixtures.ts'
import { nativeWorld } from './testing/native.ts'

class FakePeer implements Peer {
  readonly binary: Uint8Array[] = []
  readonly text: ServerControl[] = []
  closed: { code: number; reason: string } | null = null
  send(data: Uint8Array | string): void {
    if (typeof data === 'string') {
      this.text.push(JSON.parse(data) as ServerControl)
    } else {
      this.binary.push(data)
    }
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
}

const profile = (accountId: string, extra: Partial<JoinProfile> = {}): JoinProfile => ({
  accountId,
  name: accountId,
  level: 5,
  prestige: 0,
  loadout: [],
  banked: 1000,
  tcpRtt: 30,
  ...extra,
})

type WireFrame = Omit<InputFrame, 'seq' | 'viewTime'> & { viewTick: number; viewFrac: number }
const still: WireFrame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }
const pending = new WeakMap<LobbyCore, (InputFrame | null)[]>()
interface Press {
  id: number
  b: { nextSeq: number }
  f: WireFrame
}
function send(core: LobbyCore, { id, b, f }: Press, _now: number) {
  const frames = pending.get(core) ?? []
  frames[id] = { ...f, seq: b.nextSeq++, viewTime: core.world.tick - 2 }
  pending.set(core, frames)
}
function advance(core: LobbyCore, now: number) {
  const result = core.tick(now, { frames: pending.get(core) ?? [] })
  pending.delete(core)
  return result
}

describe('LobbyCore', () => {
  it('join sends the welcome roster and wallet while Colyseus owns replication', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    expect(s).not.toBeNull()
    const welcome = peer.text.find((m) => m.type === 'welcome')
    expect(welcome).toMatchObject({
      type: 'welcome',
      lobbyId: 'lobby:0',
      you: s?.playerId,
      banked: 1000,
    })
    advance(core, 50)
    advance(core, 100)
    expect(peer.binary).toHaveLength(0)
  })

  it('an explicitly synthetic core can fill32 while normal production cores remain capped', () => {
    const core = new LobbyCore('lobby:0', 1, 31)
    core.join(profile('a'), new FakePeer(), 0)
    for (let t = 0; t < 20; t++) {
      advance(core, t * 50)
    }
    const bodies = core.world.players.filter(Boolean).length
    expect(bodies).toBe(DEFAULT_TOWN_POPULATION)
    core.botTarget = 40
    for (let t = 0; t < 60; t++) {
      advance(core, t * 50)
    }
    expect(core.world.players.filter(Boolean).length).toBe(MAX_PLAYERS)
  })

  it('production caps bots at four across joins and clears them at zero online humans without reducing32 human seats', () => {
    const core = new LobbyCore('production', 11)
    const peer = new FakePeer()
    const first = core.join(profile('first'), peer, 0)
    if (!first) {
      throw new Error('Missing first human')
    }
    core.botTarget = 31
    for (let tick = 0; tick < 40; tick++) {
      advance(core, tick * 50)
    }
    expect(core.world.players.filter((player) => player?.bot && !player.gone)).toHaveLength(
      MAX_FRONTIER_BOTS,
    )
    for (let index = 1; index < MAX_PLAYERS; index++) {
      expect(core.join(profile(`human-${index}`), new FakePeer(), 2000)).not.toBeNull()
      advance(core, 2000 + index * 50)
      expect(
        core.world.players.filter((player) => player?.bot && !player.gone).length,
      ).toBeLessThanOrEqual(MAX_FRONTIER_BOTS)
    }
    expect(core.connectedHumans()).toBe(MAX_PLAYERS)
    expect(core.world.players.filter((player) => player?.bot)).toHaveLength(0)
    for (const session of core.sessions.values()) {
      if (session.peer) {
        core.disconnect(session.playerId, session.peer)
      }
    }
    expect(core.connectedHumans()).toBe(0)
    expect(core.world.players.filter((player) => player?.bot)).toHaveLength(0)
    const lone = new LobbyCore('empty', 12)
    const lonePeer = new FakePeer()
    const session = lone.join(profile('lone'), lonePeer, 0)
    for (let tick = 0; tick < 20; tick++) {
      advance(lone, tick * 50)
    }
    expect(lone.world.players.filter((player) => player?.bot)).toHaveLength(MAX_FRONTIER_BOTS)
    if (!session) {
      throw new Error('Missing lone human')
    }
    lone.disconnect(session.playerId, lonePeer)
    expect(lone.world.players.filter((player) => player?.bot)).toHaveLength(0)
    for (let tick = 20; tick < 25; tick++) {
      advance(lone, tick * 50)
    }
    expect(lone.world.players.filter((player) => player?.bot)).toHaveLength(0)
  })

  it('with ambient bots off (dev ?bots=0) the town empties of bots', () => {
    const core = new LobbyCore('lobby:0', 1)
    core.join(profile('a'), new FakePeer(), 0)
    for (let t = 0; t < 20; t++) {
      advance(core, t * 50)
    }
    expect(core.world.players.filter((p) => p?.bot && !p.gone).length).toBeGreaterThan(0)
    core.ambientPopulation = 0
    for (let t = 20; t < 40; t++) {
      advance(core, t * 50)
    }
    expect(core.world.players.filter((p) => p?.bot && !p.gone).length).toBe(0)
    expect(core.world.players.filter(Boolean).length).toBe(1)
  })

  it('a human joining a synthetic full town sends a bot home', () => {
    const core = new LobbyCore('lobby:0', 1, 31)
    core.join(profile('a'), new FakePeer(), 0)
    core.botTarget = 40
    for (let t = 0; t < 40; t++) {
      advance(core, t * 50)
    }
    for (let i = 0; i < MAX_PLAYERS - SOFT_CAP; i++) {
      core.join(profile(`h${i}`), new FakePeer(), 0)
    }
    expect(core.join(profile('late'), new FakePeer(), 0)).not.toBeNull()
  })

  it('native authoritative input frames move the player and track the consumed sequence', async () => {
    const core = new LobbyCore('lobby:0', 1)
    const simulation = await nativeWorld({
      version: 'floor',
      boxes: [{ center: [72, -0.5, 72], halfExtents: [256, 0.5, 256] }],
      meshes: [],
    })
    core.world = simulation.world
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    const id = s?.playerId ?? 0
    const p = core.world.players[id]
    const x0 = p?.x ?? 0
    const b = { nextSeq: 0 }
    for (let t = 0; t < 40; t++) {
      send(core, { id, b, f: { ...still, moveX: t < 20 ? 127 : 0 } }, t * 50)
      advance(core, t * 50)
    }
    expect(Math.abs((p?.x ?? 0) - x0)).toBeGreaterThan(3)
    expect(p?.lastSeq).toBe(39)
    simulation.dispose()
  })

  it('control floods are dropped and persistent flooding is kicked', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const session = core.join(profile('a'), peer, 0)
    for (let i = 0; i < 200; i++) {
      core.onText(session?.playerId ?? 0, JSON.stringify({ type: 'unknown' }), 10)
    }
    expect(core.metrics.droppedIn).toBeGreaterThan(100)
    expect(peer.closed?.code).toBe(1008)
  })
})

describe('LobbyCore sessions and money', () => {
  it('a reconnect within 10 s reclaims the avatar and its carry', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    const p = core.world.players[s?.playerId ?? 0]
    if (p) {
      p.carried = 250
    }
    core.disconnect(s?.playerId ?? 0, peer)
    for (let t = 0; t < 100; t++) {
      advance(core, t * 50)
    }
    const peer2 = new FakePeer()
    const again = core.join(profile('a'), peer2, 5000)
    expect(again?.playerId).toBe(s?.playerId)
    expect(core.world.players[again?.playerId ?? 0]?.carried).toBe(250)
    expect(peer2.text.some((message) => message.type === 'welcome')).toBe(true)
  })

  it('lingering out drops the carry and reports a departure', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    const p = core.world.players[s?.playerId ?? 0]
    if (p) {
      p.carried = 100
    }
    core.disconnect(s?.playerId ?? 0, peer)
    let departed = 0
    for (let t = 0; t < 220; t++) {
      departed += advance(core, t * 50).departures.length
    }
    expect(departed).toBe(1)
    expect(core.humans()).toBe(0)
  })

  it('deposits come out tagged with the session; confirming updates the wallet', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    const p = core.world.players[s?.playerId ?? 0]
    if (!(p && s)) {
      throw new Error('no player')
    }
    const bank = serviceZone('bank')
    Object.assign(p, { x: bank.x, y: bank.y ?? 0, z: bank.z })
    p.carried = 600
    p.protectUntil = 0
    const b = { nextSeq: 0 }
    const deposits: SettledDeposit[] = []
    for (let t = 0; t < 60; t++) {
      send(core, { id: s.playerId, b, f: { ...still } }, t * 50)
      deposits.push(...advance(core, t * 50).deposits)
    }
    expect(deposits).toHaveLength(1)
    expect(deposits[0]).toMatchObject({
      accountId: 'a',
      amount: 600,
      commission: 60,
      sessionId: s.sessionId,
    })
    const first = deposits[0]
    if (first) {
      core.confirmDeposit(first, true)
    }
    expect(s.banked).toBe(1660)
    expect(peer.text.at(-1)).toMatchObject({ type: 'deposit', ok: true, banked: 1660 })
  })

  it('the Badlands: a frozen account banks XP, never dollars', () => {
    const core = new LobbyCore('lobby:500', 1)
    const s = core.join(profile('cheat', { frozen: true }), new FakePeer(), 0)
    const p = core.world.players[s?.playerId ?? 0]
    if (!(p && s)) {
      throw new Error('no player')
    }
    const bank = serviceZone('bank')
    Object.assign(p, { x: bank.x, y: bank.y ?? 0, z: bank.z })
    p.carried = 600
    p.protectUntil = 0
    const b = { nextSeq: 0 }
    const deposits: SettledDeposit[] = []
    for (let t = 0; t < 60; t++) {
      send(core, { id: s.playerId, b, f: { ...still } }, t * 50)
      deposits.push(...advance(core, t * 50).deposits)
    }
    expect(deposits).toHaveLength(1)
    expect(deposits[0]).toMatchObject({ accountId: 'cheat', frozen: true })
  })

  it('players who block each other are never paired in a call-out', () => {
    const core = new LobbyCore('lobby:0', 1)
    const a = core.join(profile('a', { blocked: ['b'] }), new FakePeer(), 0)
    const b = core.join(profile('b'), new FakePeer(), 0)
    const c = core.join(profile('c'), new FakePeer(), 0)
    const [pa, pb, pc] = [a, b, c].map((s) => core.world.players[s?.playerId ?? -1])
    if (!(pa && pb && pc)) {
      throw new Error('no players')
    }
    expect(core.world.noDuel.has(pairKey(pa.id, pb.id))).toBe(true)
    expect(core.world.noDuel.has(pairKey(pa.id, pc.id))).toBe(false)
    core.world.tick = 1000
    for (const p of [pa, pb, pc]) {
      p.carried = 100
      p.lastDamageTick = 0
      p.protectUntil = 0
    }
    // a aims straight at b, 5 m away: no target. c in the same spot is a fair target.
    pa.x = 60
    pa.z = 60
    pa.aim = 0
    pb.x = 65
    pb.z = 60
    pc.x = 200
    pc.z = 200
    expect(calloutTarget(core.world, pa)).toBeNull()
    pc.x = 65
    pc.z = 60
    pb.x = 200
    expect(calloutTarget(core.world, pa)?.id).toBe(pc.id)
  })

  it('a showdown against a bot runs end to end: bell, human draw, verdict', () => {
    const core = new LobbyCore('lobby:0', 3)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    advance(core, 0)
    const me = core.world.players[s?.playerId ?? 0]
    const bot = core.world.players.find((q) => q?.bot && q.id % 4 !== 0)
    if (!(me && bot && s)) {
      throw new Error('setup')
    }
    me.x = 30
    me.z = 64
    me.carried = 100
    bot.x = 36
    bot.z = 64
    bot.carried = 100
    bot.lastDamageTick = -1000
    me.lastDamageTick = -1000
    const b = { nextSeq: 0 }
    let callAt = -1
    let ended = false
    for (let t = 1; t < 200 && !ended; t++) {
      bot.x = me.showdown < 0 ? 36 : bot.x
      bot.z = me.showdown < 0 ? 64 : bot.z
      send(
        core,
        { id: s.playerId, b, f: { ...still, aim: 0, buttons: t % 4 === 1 ? BTN_CALLOUT : 0 } },
        t * 50,
      )
      advance(core, t * 50)
      if (callAt < 0 && peer.text.some((m) => m.type === 'showdown_call')) {
        callAt = t * 50
        const call = peer.text.find((m) => m.type === 'showdown_call')
        core.onText(
          s.playerId,
          JSON.stringify({
            type: 'showdown_shot',
            showdownId: call?.type === 'showdown_call' ? call.showdownId : 0,
            localMs: 150,
          }),
          t * 50 + 150,
        )
      }
      ended = callAt > 0 && me.showdown < 0
    }
    expect(callAt).toBeGreaterThan(0)
    expect(ended).toBe(true)
    // The human drew in 150 ms; bots draw in 190–340 ms.
    expect(bot.alive).toBe(false)
    expect(me.alive).toBe(true)
  })
})

describe('LobbyCore live call-out blocks', () => {
  it('applies live block truth to both riders without cancelling an active showdown', () => {
    const core = new LobbyCore('lobby:0', 1)
    const a = core.join(profile('a'), new FakePeer(), 0)
    const b = core.join(profile('b'), new FakePeer(), 0)
    const pa = core.world.players[a?.playerId ?? -1]
    const pb = core.world.players[b?.playerId ?? -1]
    if (!(a && b && pa && pb)) {
      throw new Error('no players')
    }
    core.world.tick = 1000
    Object.assign(pa, { x: 60, z: 60, aim: 0, carried: 100, protectUntil: 0 })
    Object.assign(pb, { x: 65, z: 60, aim: Math.PI, carried: 100, protectUntil: 0 })
    const pair = pairKey(pa.id, pb.id)

    handleCallout(core.world, pa, BTN_CALLOUT)
    expect(pb.calledBy).toBe(pa.id)
    core.setCalloutBlocked('b', 'a', true)
    expect(pb.calledBy).toBe(NONE)
    expect(core.world.noDuel.has(pair)).toBe(true)
    expect(calloutTarget(core.world, pa)).toBeNull()
    expect(calloutTarget(core.world, pb)).toBeNull()
    handleCallout(core.world, pb, BTN_CALLOUT)
    expect(core.world.showdowns.size).toBe(0)

    core.join(profile('a'), new FakePeer(), 50, [])
    expect(core.world.noDuel.has(pair)).toBe(false)
    expect(b.blocked.has('a')).toBe(false)
    expect(calloutTarget(core.world, pa)?.id).toBe(pb.id)
    pa.calloutCooldownUntil = 0
    handleCallout(core.world, pa, BTN_CALLOUT)
    handleCallout(core.world, pb, BTN_CALLOUT)
    expect(core.world.showdowns.size).toBe(1)
    core.setCalloutBlocked('a', 'b', true)
    expect(core.world.showdowns.size).toBe(1)
  })

  it('fences a pending join and applies delayed updates to account IDs after slot reuse', async () => {
    const core = new LobbyCore('lobby:0', 1, 0)
    const a = core.join(profile('a'), new FakePeer(), 0)
    if (!a) {
      throw new Error('a did not join')
    }
    const oldRead = Promise.withResolvers<readonly string[]>()
    const delayedPair = Promise.withResolvers<boolean>()
    const readingPair = Promise.withResolvers<void>()
    let accountReads = 0
    let pairReads = 0
    const blocks = new CalloutBlocks({
      core: () => core,
      readAccount: () => (++accountReads === 1 ? oldRead.promise : Promise.resolve(['a'])),
      readPair: () => {
        if (++pairReads === 1) {
          return Promise.resolve(true)
        }
        readingPair.resolve()
        return delayedPair.promise
      },
    })
    const pendingJoin = blocks.readJoin('b')
    await blocks.refresh('a', 'b')
    oldRead.resolve([])
    expect((await pendingJoin).current()).toBe(false)
    const current = await blocks.readJoin('b')
    expect(current.current()).toBe(true)
    const peer = new FakePeer()
    const b = core.join(profile('b'), peer, 0, current.accounts)
    if (!b) {
      throw new Error('b did not join')
    }
    const pair = pairKey(a.playerId, b.playerId)
    expect(core.world.noDuel.has(pair)).toBe(true)

    const delayed = blocks.refresh('a', 'b')
    await readingPair.promise
    core.disconnect(b.playerId, peer)
    for (let t = 0; t < 220; t++) {
      advance(core, t * 50)
    }
    const c = core.join(profile('c'), new FakePeer(), 11_000, [])
    expect(c?.playerId).toBe(b.playerId)
    expect(core.world.noDuel.has(pair)).toBe(false)
    delayedPair.resolve(true)
    await delayed
    expect(core.world.noDuel.has(pair)).toBe(false)
    expect(c?.blocked.size).toBe(0)
  })
})
