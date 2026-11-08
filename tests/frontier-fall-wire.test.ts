import { expect, it } from 'bun:test'
import { Decoder, Encoder } from '@colyseus/schema'
import { applyFrontierState } from '../src/experiments/out-west/client/state.ts'
import { COLLISION_VERSION } from '../src/experiments/out-west/content/manifest.ts'
import { createWorld } from '../src/experiments/out-west/ffa/sim/state.ts'
import { type PlayerState, PROTOCOL_VERSION } from '../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState, PlayerRecord } from '../src/experiments/out-west/runtime/schema.ts'

it.each([-3276.8, -25.8, -16.2, -12.8, 0, 6.9, 12.8, 3276.7])(
  'retains signed falling velocity %f through real Colyseus encoding',
  (vy) => {
    const source = new FrontierState()
    source.protocol = PROTOCOL_VERSION
    source.content = COLLISION_VERSION
    const player = new PlayerRecord()
    player.id = '0'
    player.x = 20
    player.y = 8
    player.z = 64
    player.vy = vy
    player.grounded = false
    player.hp = 0
    player.motion.support = 3.27
    player.motion.airPeakY = 17.22
    player.motion.mantleTicks = 6
    source.players.set('0', player)
    const encoded = new Encoder(source).encodeAll()
    const decoded = new FrontierState()
    new Decoder(decoded).decode(encoded)
    const world = createWorld()
    const poses = new Map<string, PlayerState>()
    applyFrontierState(decoded, world, poses, new Map())
    expect(world.players[0]?.vy).toBeCloseTo(vy, 3)
    expect(world.players[0]?.y).toBe(8)
    expect(world.players[0]?.grounded).toBe(false)
    expect(world.players[0]?.support).toBeCloseTo(3.27, 3)
    expect(world.players[0]?.airPeakY).toBeCloseTo(17.22, 3)
    expect(world.players[0]?.mantleTicks).toBe(6)
    expect(poses.get('0')?.vy).toBeCloseTo(vy, 3)
    expect(poses.get('0')?.y).toBeCloseTo(8.9, 3)
    expect(poses.get('0')?.hp).toBe(0)
  },
)
