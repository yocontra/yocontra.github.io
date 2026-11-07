import { describe, expect, it } from 'bun:test'
import { LobbyCore } from '../api/src/town/core.ts'
import {
  BTN_FIRE,
  CONTRACT_VERSION,
  MSG_FULL_RESET,
  type ServerControl,
  TOWN_WIRE_VERSION,
} from '../src/experiments/out-west/contract/town.ts'
import { LoopbackServer } from '../src/experiments/out-west/ffa/client/loopback-server.ts'
import { NetClient } from '../src/experiments/out-west/ffa/client/net.ts'
import { decodeInput } from '../src/experiments/out-west/ffa/sim/codec.ts'

function fixture() {
  const packets: (Uint8Array | string)[] = []
  const core = new LobbyCore('wire-test', 1)
  core.ambientPopulation = 0
  core.join(
    {
      accountId: 'wire-test',
      name: 'You',
      level: 1,
      prestige: 0,
      loadout: [],
      banked: 100,
      tcpRtt: null,
    },
    { send: (packet) => packets.push(packet), close: () => undefined },
    0,
  )
  core.tick(50)
  const welcome = packets.find((packet) => typeof packet === 'string')
  const snapshot = packets.find((packet) => packet instanceof Uint8Array && packet.length > 1)
  if (typeof welcome !== 'string' || !(snapshot instanceof Uint8Array)) {
    throw new Error('LobbyCore did not send its welcome and first snapshot')
  }
  const welcomes: number[] = []
  const incompatible: string[] = []
  const controls: ServerControl[] = []
  const sent: (Uint8Array | string)[] = []
  const predictedPitches: number[] = []
  let closed = 0
  const client = new NetClient({
    onWelcome: (id) => welcomes.push(id),
    onIncompatible: (message) => incompatible.push(message),
    onControl: (msg) => controls.push(msg),
    onEvent: () => undefined,
    onPredictedShot: (...shot) => predictedPitches.push(shot[4]),
  })
  client.attach({
    kind: 'remote',
    send: (packet) => sent.push(packet),
    close: () => closed++,
  })
  const receiveSnapshot = () => client.handle(snapshot.slice().buffer, 50)
  const receiveWelcome = () => client.handle(welcome, 0)
  return {
    client,
    welcomes,
    incompatible,
    controls,
    sent,
    predictedPitches,
    closed: () => closed,
    receiveSnapshot,
    receiveWelcome,
    welcome: JSON.parse(welcome) as Record<string, unknown>,
  }
}

describe('Frontier welcome compatibility', () => {
  it('predicts the same integer pitch transmitted in the input batch', () => {
    const f = fixture()
    f.receiveWelcome()
    f.receiveSnapshot()
    const intent = { moveX: 0, moveZ: 0, aim: 0, buttons: BTN_FIRE, pitch: 1.6 }
    f.client.tick(intent, 0, 50)
    f.client.tick({ ...intent, buttons: 0 }, 0, 100)
    const packet = f.sent[0]
    if (!(packet instanceof Uint8Array)) {
      throw new Error('the client did not send its input batch')
    }
    expect(f.predictedPitches).toEqual([2])
    expect(decodeInput(packet)?.frames.map((frame) => frame.pitch)).toEqual([2, 2])
  })

  it('waits for an exact v10 welcome before decoding snapshots or sending input', () => {
    const f = fixture()
    expect(CONTRACT_VERSION).toBe(10)
    expect(TOWN_WIRE_VERSION).toBe(CONTRACT_VERSION)
    f.receiveSnapshot()
    f.client.tick({ moveX: 0, moveZ: 0, aim: 0, buttons: 0 }, 0, 0)
    expect(f.client.snaps).toBe(0)
    expect(f.client.self).toBeNull()
    expect(f.sent).toHaveLength(0)
    f.receiveWelcome()
    f.receiveSnapshot()
    expect(f.welcomes).toEqual([0])
    expect(f.client.snaps).toBe(1)
    expect(f.client.self).not.toBeNull()
    expect(f.incompatible).toHaveLength(0)
    expect(f.closed()).toBe(0)
  })

  it.each([9, 11, undefined, null, '10', 10.1, true, {}])(
    'closes once and ignores later packets for incompatible version %j',
    (version) => {
      const f = fixture()
      f.client.handle(JSON.stringify({ ...f.welcome, contractVersion: version }), 0)
      f.receiveSnapshot()
      f.client.handle(new Uint8Array([MSG_FULL_RESET]).buffer, 1)
      f.receiveWelcome()
      f.receiveSnapshot()
      f.client.tick({ moveX: 0, moveZ: 0, aim: 0, buttons: 0 }, 0, 0)
      expect(f.incompatible).toEqual([
        'The town is updating. Refresh the page in a moment to play.',
      ])
      expect(f.closed()).toBe(1)
      expect(f.welcomes).toHaveLength(0)
      expect(f.controls).toHaveLength(0)
      expect(f.client.snaps).toBe(0)
      expect(f.client.you).toBe(-1)
      expect(f.client.roster.size).toBe(0)
      expect(f.sent).toHaveLength(0)
    },
  )

  it('preserves the accepted version during an in-session baseline reset', () => {
    const f = fixture()
    f.receiveWelcome()
    f.receiveSnapshot()
    f.client.handle(new Uint8Array([MSG_FULL_RESET]).buffer, 100)
    f.receiveSnapshot()
    expect(f.client.snaps).toBe(2)
    expect(f.welcomes).toEqual([0])
    expect(f.closed()).toBe(0)
  })

  it('requires a fresh compatible welcome after reconnect and resumes normally', () => {
    const f = fixture()
    f.receiveWelcome()
    f.receiveSnapshot()
    f.client.reset()
    f.client.handle(new Uint8Array([MSG_FULL_RESET]).buffer, 100)
    f.receiveSnapshot()
    expect(f.client.snaps).toBe(1)
    f.receiveWelcome()
    f.receiveSnapshot()
    expect(f.client.snaps).toBe(2)
    expect(f.welcomes).toEqual([0, 0])
    expect(f.closed()).toBe(0)
  })

  it.each([undefined, { rounds: 0, kd: 0 }])(
    'accepts the real loopback/practice startup welcome (%j)',
    (practice) => {
      const f = fixture()
      const server = new LoopbackServer({ bots: 0, ...(practice ? { practice } : {}) }, (packet) =>
        f.client.handle(typeof packet === 'string' ? packet : packet.slice().buffer, 0),
      )
      try {
        server.start()
        expect(f.welcomes).toEqual([0])
        expect(f.closed()).toBe(0)
        expect(f.incompatible).toHaveLength(0)
      } finally {
        server.stop()
      }
    },
  )
})
