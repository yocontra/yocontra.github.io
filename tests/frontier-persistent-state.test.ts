import { describe, expect, it } from 'bun:test'
import { Decoder, Encoder } from '@colyseus/schema'
import { applyFrontierState } from '../src/experiments/out-west/client/state.ts'
import { COLLISION_VERSION } from '../src/experiments/out-west/content/manifest.ts'
import { createWorld } from '../src/experiments/out-west/ffa/sim/state.ts'
import { type PlayerState, PROTOCOL_VERSION } from '../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState, PlayerRecord } from '../src/experiments/out-west/runtime/schema.ts'

function state() {
  const source = new FrontierState()
  source.protocol = PROTOCOL_VERSION
  source.content = COLLISION_VERSION
  source.tick = 71
  return source
}
function game() {
  return {
    bags: [],
    strongbox: null,
    pickups: [],
    fuses: [],
    showdowns: [],
    mostWanted: 255,
    glass: [1, 0, 1],
  }
}
function decode(source: FrontierState): FrontierState {
  const target = new FrontierState()
  new Decoder(target).decode(new Encoder(source).encodeAll())
  return target
}

describe('Frontier native persistent state', () => {
  it('restores complete join state beyond the old event cap without replaying effects', () => {
    const source = state()
    source.game = JSON.stringify({
      ...game(),
      bags: Array.from({ length: 300 }, (_, id) => ({
        id,
        x: 20,
        z: 64,
        amount: 100 + id,
        style: 0,
        exclusiveFor: 255,
        exclusiveUntil: 0,
        expiresAt: 200,
      })),
      pickups: [{ spot: 0, availableAt: 100 }],
      fuses: [{ by: 0, x: 22, z: 64, explodeAt: 90 }],
      showdowns: [
        [
          1,
          {
            id: 1,
            a: 0,
            b: 1,
            cx: 20,
            cz: 64,
            startTick: 50,
            callTick: 90,
            fakeTicks: [],
            phase: 'wait',
          },
        ],
      ],
      strongbox: { spot: 0, value: 900, openedBy: 255, progress: 0 },
    })
    const world = createWorld()
    const poses = new Map<string, PlayerState>()
    applyFrontierState(decode(source), world, poses, new Map())
    expect(world.tick).toBe(71)
    expect(world.bags).toHaveLength(300)
    expect(world.bags.at(-1)?.amount).toBe(399)
    expect(world.pickups[0]?.availableAt).toBe(100)
    expect(world.fuses[0]?.explodeAt).toBe(90)
    expect(world.showdowns.get(1)?.phase).toBe('wait')
    expect(world.strongbox?.value).toBe(900)
    expect([...world.glass]).toEqual([1, 0, 1])
    expect(world.events).toEqual([])
  })
  it('replaces stale join state and removes departed riders atomically', () => {
    const source = state()
    source.game = JSON.stringify(game())
    const player = new PlayerRecord()
    player.id = '0'
    player.name = 'Rider'
    source.players.set('0', player)
    const world = createWorld()
    const poses = new Map<string, PlayerState>()
    const encoder = new Encoder(source)
    const decoded = new FrontierState()
    const decoder = new Decoder(decoded)
    decoder.decode(encoder.encodeAll())
    encoder.discardChanges()
    applyFrontierState(decoded, world, poses, new Map())
    expect(world.players[0]?.name).toBe('Rider')
    expect(poses.has('0')).toBe(true)
    source.players.clear()
    source.game = JSON.stringify({ ...game(), bags: [] })
    source.tick++
    decoder.decode(encoder.encode())
    applyFrontierState(decoded, world, poses, new Map())
    expect(world.players[0]).toBeNull()
    expect(poses.has('0')).toBe(false)
  })
  it.each(['{', 'null', '{}', '{"bags":false}'])(
    'rejects malformed persistent state without partial application: %s',
    (invalid) => {
      const source = state()
      source.game = JSON.stringify(game())
      const world = createWorld()
      const poses = new Map<string, PlayerState>()
      applyFrontierState(source, world, poses, new Map())
      const oldPlayers = world.players
      const oldGlass = world.glass
      source.tick = 100
      source.game = invalid
      expect(() => applyFrontierState(source, world, poses, new Map())).toThrow()
      expect(world.tick).toBe(71)
      expect(world.players).toBe(oldPlayers)
      expect(world.glass).toBe(oldGlass)
    },
  )
})
