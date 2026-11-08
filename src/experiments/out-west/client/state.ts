import { COLLISION_VERSION } from '../content/manifest.ts'
import { newPlayer, type World } from '../ffa/sim/state.ts'
import type { Channel, PlayerStats } from '../ffa/sim/types.ts'
import { MAX_PLAYERS, type PlayerState, PROTOCOL_VERSION } from '../runtime/protocol.ts'
import type { FrontierState } from '../runtime/schema.ts'
import type { Appearance } from './actors.ts'

export function assertCompatibility(state: FrontierState): void {
  if (state.protocol !== PROTOCOL_VERSION || state.content !== COLLISION_VERSION) {
    throw new Error('The town was updated. Reload the page to play.')
  }
}
function finiteJson(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Invalid town number')
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      finiteJson(child)
    }
  }
}
function gameData(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid town state')
  }
  const record = parsed as Record<string, unknown>
  for (const key of ['bags', 'pickups', 'fuses', 'showdowns', 'glass']) {
    if (!Array.isArray(record[key])) {
      throw new Error(`Invalid town ${key}`)
    }
  }
  finiteJson(record)
  return record
}
export function applyFrontierState(
  state: FrontierState,
  world: World,
  poses: Map<string, PlayerState>,
  appearances: Map<string, Appearance>,
): void {
  assertCompatibility(state)
  if (state.players.size > MAX_PLAYERS) {
    throw new Error('Too many riders')
  }
  const next: World = { ...world, players: Array.from({ length: MAX_PLAYERS }, () => null) }
  const nextPoses = new Map<string, PlayerState>()
  const nextAppearances = new Map<string, Appearance>()
  next.tick = state.tick
  for (const record of state.players.values()) {
    if (!nextPoses.has(record.id)) {
      nextPoses.set(record.id, {
        id: record.id,
        x: record.x,
        y: record.y + 0.9,
        z: record.z,
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
    const index = Number(record.id)
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PLAYERS || next.players[index]) {
      throw new Error('Invalid rider slot')
    }
    finiteJson(record.toJSON())
    const player = newPlayer(Number(record.id), {
      accountId: '',
      name: record.name,
      level: record.level,
      prestige: record.prestige,
      bot: record.bot,
      saddlebag: record.saddlebag,
    })
    Object.assign(player, record.toJSON(), record.motion.toJSON())
    player.id = Number(record.id)
    const details = JSON.parse(record.details || '{}') as {
      stats?: PlayerStats
      channel?: Channel | null
      appearance?: Omit<Appearance, 'key'>
    }
    if (details.appearance) {
      nextAppearances.set(record.id, {
        ...details.appearance,
        key: JSON.stringify(details.appearance),
      })
    }
    if (details.stats) {
      player.stats = details.stats
    }
    player.channel = details.channel ?? null
    next.players[player.id] = player
  }
  if (state.game) {
    const game = gameData(state.game) as {
      bags: typeof world.bags
      strongbox: typeof world.strongbox
      pickups: typeof world.pickups
      fuses: typeof world.fuses
      showdowns: [number, typeof world.showdowns extends Map<number, infer V> ? V : never][]
      mostWanted: number
      glass: number[]
    }
    next.bags = game.bags
    next.strongbox = game.strongbox
    next.pickups = game.pickups
    next.fuses = game.fuses
    next.showdowns = new Map(game.showdowns)
    next.mostWanted = game.mostWanted
    next.glass = new Uint8Array(game.glass)
  }
  Object.assign(world, next)
  poses.clear()
  appearances.clear()
  for (const [id, pose] of nextPoses) {
    poses.set(id, pose)
  }
  for (const [id, appearance] of nextAppearances) {
    appearances.set(id, appearance)
  }
}
