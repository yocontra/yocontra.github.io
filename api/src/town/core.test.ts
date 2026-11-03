import { describe, expect, test as it } from 'bun:test'
import {
  BTN_CALLOUT,
  BTN_INTERACT,
  MSG_FULL_RESET,
  MSG_SNAPSHOT,
  type ServerControl,
} from '../../../src/experiments/out-west/contract/town.ts'
import { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import {
  decodeSnapshot,
  type EntityView,
  encodeInput,
  type WireFrame,
} from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import { MAX_PLAYERS, SOFT_CAP } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { InputBatcher } from '../../../src/experiments/out-west/ffa/sim/input.ts'
import { calloutTarget } from '../../../src/experiments/out-west/ffa/sim/showdown.ts'
import { pairKey } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import {
  DEFAULT_TOWN_POPULATION,
  type JoinProfile,
  LobbyCore,
  type Peer,
  type SettledDeposit,
} from './core.ts'

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

const still: WireFrame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }

/** One player's input `f`, pushed through their batcher `b`. */
interface Press {
  id: number
  b: InputBatcher
  f: WireFrame
}

function send(core: LobbyCore, { id, b, f }: Press, now: number): void {
  const msg = b.push({ ...f, viewTick: (core.world.tick - 2) & 0xff_ff })
  if (msg) {
    core.onBinary(
      id,
      encodeInput(new Writer(64), {
        ...msg,
        ackTick: (core.world.tick - 1) & 0xff_ff,
        ackAgeMs: 5,
      }),
      now,
    )
  }
}

describe('LobbyCore', () => {
  it('join: full reset, welcome with roster and wallet, then a full snapshot every tick', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    expect(s).not.toBeNull()
    expect(peer.binary[0]).toEqual(new Uint8Array([MSG_FULL_RESET]))
    const welcome = peer.text.find((m) => m.type === 'welcome')
    expect(welcome).toMatchObject({
      type: 'welcome',
      lobbyId: 'lobby:0',
      you: s?.playerId,
      banked: 1000,
    })
    core.tick(50)
    core.tick(100)
    const snaps = peer.binary.filter((b) => b[0] === MSG_SNAPSHOT)
    expect(snaps.length).toBe(2)
    const base = new Map<number, EntityView>()
    expect((decodeSnapshot(snaps[0] ?? new Uint8Array(), base)?.flags ?? 0) & 1).toBe(1)
  })

  it('fills the town with bots while a human is present, never past 28', () => {
    const core = new LobbyCore('lobby:0', 1)
    core.join(profile('a'), new FakePeer(), 0)
    for (let t = 0; t < 20; t++) {
      core.tick(t * 50)
    }
    const bodies = core.world.players.filter(Boolean).length
    expect(bodies).toBe(DEFAULT_TOWN_POPULATION)
    core.botTarget = 40
    for (let t = 0; t < 60; t++) {
      core.tick(t * 50)
    }
    expect(core.world.players.filter(Boolean).length).toBe(MAX_PLAYERS)
  })

  it('a human joining a full town sends a bot home', () => {
    const core = new LobbyCore('lobby:0', 1)
    core.join(profile('a'), new FakePeer(), 0)
    core.botTarget = 40
    for (let t = 0; t < 40; t++) {
      core.tick(t * 50)
    }
    for (let i = 0; i < MAX_PLAYERS - SOFT_CAP; i++) {
      core.join(profile(`h${i}`), new FakePeer(), 0)
    }
    expect(core.join(profile('late'), new FakePeer(), 0)).not.toBeNull()
  })

  it('send-on-change inputs move the player and lastInputSeq tracks the client', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    const id = s?.playerId ?? 0
    const p = core.world.players[id]
    const x0 = p?.x ?? 0
    const b = new InputBatcher()
    for (let t = 0; t < 40; t++) {
      send(core, { id, b, f: { ...still, moveX: t < 20 ? 127 : 0 } }, t * 50)
      core.tick(t * 50)
    }
    expect(Math.abs((p?.x ?? 0) - x0)).toBeGreaterThan(3)
    expect(s?.msgsIn).toBeLessThan(15)
    expect(s?.rtt.length).toBeGreaterThan(0)
  })

  it('floods are dropped and persistent flooding is kicked; garbage is kicked', () => {
    const core = new LobbyCore('lobby:0', 1)
    const peer = new FakePeer()
    const s = core.join(profile('a'), peer, 0)
    for (let i = 0; i < 200; i++) {
      core.onBinary(
        s?.playerId ?? 0,
        new Uint8Array([1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        10,
      )
    }
    expect(core.metrics.droppedIn).toBeGreaterThan(100)
    expect(peer.closed?.code).toBe(1008)
    const peer2 = new FakePeer()
    const s2 = core.join(profile('b'), peer2, 2000)
    for (let i = 0; i < 25; i++) {
      core.onBinary(s2?.playerId ?? 0, new Uint8Array([7, 7, 7]), 2000 + i * 100)
    }
    expect(peer2.closed?.code).toBe(1008)
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
      core.tick(t * 50)
    }
    const peer2 = new FakePeer()
    const again = core.join(profile('a'), peer2, 5000)
    expect(again?.playerId).toBe(s?.playerId)
    expect(core.world.players[again?.playerId ?? 0]?.carried).toBe(250)
    expect(peer2.binary[0]).toEqual(new Uint8Array([MSG_FULL_RESET]))
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
      departed += core.tick(t * 50).departures.length
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
    p.x = 64.5
    p.z = 81.5
    p.carried = 600
    p.protectUntil = 0
    const b = new InputBatcher()
    const deposits: SettledDeposit[] = []
    for (let t = 0; t < 60; t++) {
      send(core, { id: s.playerId, b, f: { ...still, buttons: BTN_INTERACT } }, t * 50)
      deposits.push(...core.tick(t * 50).deposits)
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
    p.x = 64.5
    p.z = 81.5
    p.carried = 600
    p.protectUntil = 0
    const b = new InputBatcher()
    const deposits: SettledDeposit[] = []
    for (let t = 0; t < 60; t++) {
      send(core, { id: s.playerId, b, f: { ...still, buttons: BTN_INTERACT } }, t * 50)
      deposits.push(...core.tick(t * 50).deposits)
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
    core.tick(0)
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
    const b = new InputBatcher()
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
      core.tick(t * 50)
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
