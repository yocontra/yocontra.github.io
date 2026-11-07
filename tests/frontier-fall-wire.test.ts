import { expect, it } from 'bun:test'
import { Group, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LobbyCore } from '../api/src/town/core.ts'
import { place, run } from '../api/src/town/test-helpers.ts'
import { EV_KILL, NONE, POS_SCALE } from '../src/experiments/out-west/contract/town.ts'
import type { Sink } from '../src/experiments/out-west/ffa/client/events.ts'
import { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import { NetClient } from '../src/experiments/out-west/ffa/client/net.ts'
import type { CorpseRig } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { Writer } from '../src/experiments/out-west/ffa/sim/bytes.ts'
import { decodeSnapshot, type EntityView } from '../src/experiments/out-west/ffa/sim/codec.ts'
import type { WireEvent } from '../src/experiments/out-west/ffa/sim/codec-events.ts'
import { JUMP_APEX } from '../src/experiments/out-west/ffa/sim/constants.ts'
import { killPlayer } from '../src/experiments/out-west/ffa/sim/death.ts'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import {
  ClientStream,
  persistentStateFor,
  snapshotFor,
} from '../src/experiments/out-west/ffa/sim/snapshot.ts'
import { removePlayer } from '../src/experiments/out-west/ffa/sim/world.ts'

function fallingClient(height: number, event: (ev: WireEvent) => void = () => undefined) {
  const client = new NetClient({
    onWelcome: () => undefined,
    onControl: () => undefined,
    onEvent: event,
    onPredictedShot: () => undefined,
  })
  const core = new LobbyCore('fall-wire', 7)
  core.ambientPopulation = 0
  core.world.nextStrongboxTick = 1_000_000
  core.join(
    {
      accountId: 'fall',
      name: 'Falling Rider',
      level: 10,
      prestige: 0,
      loadout: [],
      banked: 0,
      tcpRtt: null,
    },
    {
      send: (data) => client.handle(typeof data === 'string' ? data : data.slice().buffer, 0),
      close: () => undefined,
    },
    0,
  )
  const player = core.world.players[0]
  if (!player) {
    throw new Error('Real core join did not create its player')
  }
  Object.assign(player, {
    x: 20,
    z: 64,
    y: height,
    grounded: false,
    support: 0,
    airPeakY: height,
    vy: 0,
    protectUntil: 0,
    spawnTick: -10_000,
  })
  const stream = new ClientStream()
  const packet = () =>
    snapshotFor(
      core.world,
      { viewer: player, stream },
      { banked: 0, events: core.world.events },
      new Writer(1),
    )
  const receive = () => {
    client.handle(packet().slice().buffer, core.world.tick * 50)
    client.handle(
      JSON.stringify({ type: 'town_state', state: persistentStateFor(core.world) }),
      core.world.tick * 50,
    )
  }
  return { client, player, world: core.world, receive, packet }
}

it.each([-3276.8, -25.8, -16.2, -12.8, 0, 6.9, 12.8, 3276.7])(
  'retains signed vertical speed %f m/s and the following self fields at decimetre precision',
  (vy) => {
    const f = fallingClient(8)
    Object.assign(f.player, { vy, grounded: true, support: 3.27, airPeakY: 17.22, mantleTicks: 6 })
    const decoded = decodeSnapshot(f.packet(), new Map())?.self
    expect(decoded?.vy).toBe(vy)
    expect(decoded?.grounded).toBe(1)
    expect(decoded?.support).toBe(3.27)
    expect(decoded?.airPeakY).toBe(17.22)
    expect(decoded?.mantleTicks).toBe(6)
  },
)

it('rejects every truncated packet through the widened self block and following fields', () => {
  const f = fallingClient(8)
  f.player.vy = -16.2
  const bytes = f.packet()
  for (let length = 0; length < bytes.length; length++) {
    expect(decodeSnapshot(bytes.slice(0, length), new Map())).toBeNull()
  }
  expect(decodeSnapshot(bytes, new Map())?.self.vy).toBe(-16.2)
})

it('commits entity removals and deltas only after the entire snapshot is valid', () => {
  const f = fallingClient(8)
  const removed = place(f.world, 22, 64)
  const changed = place(f.world, 24, 64)
  const baseline = new Map<number, EntityView>()
  expect(decodeSnapshot(f.packet(), baseline)).not.toBeNull()
  const before = [...baseline]
  removePlayer(f.world, removed.id)
  changed.x += 0.1
  f.world.tick++
  f.world.events.length = 0
  const packet = f.packet()
  expect(decodeSnapshot(packet.slice(0, -1), baseline)).toBeNull()
  expect([...baseline]).toEqual(before)
  const unknownEvent = new Uint8Array(packet.length + 1)
  unknownEvent.set(packet)
  unknownEvent[packet.length - 1] = 1
  unknownEvent[packet.length] = 255
  expect(decodeSnapshot(unknownEvent, baseline)).toBeNull()
  expect([...baseline]).toEqual(before)
  expect(decodeSnapshot(packet, baseline)).not.toBeNull()
  expect(baseline.has(removed.id)).toBe(false)
  expect(baseline.get(changed.id)?.x).toBe(Math.round(changed.x * POS_SCALE))
})

it('retains every authoritative roof-fall velocity through the real core welcome, wire and prediction', () => {
  const roof = Math.max(...TOWN.buildings.map((b) => b.height + (b.roof?.rise ?? 0)))
  const f = fallingClient(roof + JUMP_APEX)
  let fastest = 0
  let samples = 0
  while (!f.player.grounded && samples < 100) {
    run(f.world, 1)
    f.receive()
    const expected = Math.round(f.player.vy * 10) / 10
    expect(f.client.self?.vy).toBe(expected)
    expect(f.client.pred.vy).toBe(expected)
    expect(f.client.persistent.ready).toBe(true)
    fastest = Math.min(fastest, expected)
    samples++
  }
  expect(f.player.grounded).toBe(true)
  expect(fastest).toBeLessThan(-20)
})

it('preserves the captured falling body through a real kill snapshot after prediction has stopped', async () => {
  let sink: Sink | undefined
  const f = fallingClient(8, (ev) => {
    if (ev.type === EV_KILL) {
      sink?.ragdollKilled(ev.victim, { x: f.player.x, y: f.player.y, z: f.player.z }, null, null)
    }
  })
  run(f.world, 18)
  f.receive()
  expect(f.client.pred.vy).toBe(-16.2)
  const captured: CorpseRig = {
    identity: 'actual-falling-life',
    root: new Group(),
    velocity: new Vector3(0, f.client.pred.vy, 0),
    links: [
      {
        key: 'Hips',
        parent: -1,
        position: new Vector3(20, 1.4, 64),
        start: new Vector3(20, 1.4, 64),
        end: new Vector3(20, 1.6, 64),
        rotation: new Quaternion(),
        radius: 0.1,
        mass: 12,
      },
    ],
    floor: { value: 0 },
    pose: () => undefined,
    dispose: () => undefined,
  }
  const props = await new GLTFLoader().parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  const pool = new Ragdolls({
    root: new Group(),
    grid: f.world.grid,
    props,
    source: {
      captureCorpse: () => Promise.resolve(captured),
      suppressCorpse: () => true,
      releaseCorpse: () => undefined,
    },
  })
  const game = { net: f.client, ragdolls: pool, crowdList: [], hud: null, audio: null }
  Object.setPrototypeOf(game, FrontierGame.prototype)
  sink = Reflect.apply(Reflect.get(FrontierGame.prototype, 'makeSink'), game, [])
  try {
    killPlayer(f.world, f.player, NONE)
    expect(f.player.vy).toBe(0)
    f.receive()
    expect(f.client.pred.vy).toBe(0)
    await pool.recoverDead(
      [{ id: 0, x: f.player.x, y: f.player.y, z: f.player.z }],
      f.world.tick,
      () => true,
    )
    const body = pool.world.bodies.find((part) => part.mass > 0)
    expect(pool.stats.corpses).toBe(1)
    expect(body?.velocity.y).toBe(-16.2)
    // An update shorter than one physics step still exercises the per-frame speed limiter.
    pool.update(0.001)
    expect(body?.velocity.y).toBe(-16.2)
  } finally {
    pool.dispose()
  }
})
