import { decodePropHealth } from '../content/environment-props.ts'
import { COLLISION_VERSION } from '../content/manifest.ts'
import { refreshPropGrid } from '../ffa/sim/environment-response.ts'
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
function environmentState(game: Record<string, unknown>) {
  const seed = game.seed
  if (!Number.isInteger(seed) || typeof seed !== 'number' || seed < 0 || seed > 0xff_ff_ff_ff) {
    throw new Error('Invalid town seed')
  }
  return { health: decodePropHealth(game.props), seed }
}
/** Prediction adopts static cover before replaying commands from this decoded snapshot. */
export function environmentFromSnapshot(value: string) {
  return environmentState(gameData(value))
}
export function propsFromSnapshot(value: string): Uint8Array {
  return environmentFromSnapshot(value).health
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
    const decoded = record.toJSON()
    finiteJson(decoded)
    const player = newPlayer(index, {
      accountId: '',
      name: record.name,
      level: record.level,
      prestige: record.prestige,
      bot: record.bot,
      saddlebag: record.saddlebag,
    })
    Object.assign(player, decoded, decoded.motion)
    player.id = index
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
      props: number[]
      seed: number
    }
    next.bags = game.bags
    next.strongbox = game.strongbox
    next.pickups = game.pickups
    next.fuses = game.fuses
    next.showdowns = new Map(game.showdowns)
    next.mostWanted = game.mostWanted
    next.glass = new Uint8Array(game.glass)
    if (!adoptEnvironment(next, world, environmentState(game))) {
      return
    }
  }
  const reset = next.seed !== world.seed && next.tick < world.tick
  const beforeGrid = world.grid
  refreshPropGrid(next, world.props, reset)
  Object.assign(world, next)
  if (beforeGrid !== world.grid) {
    world.propsChanged?.(reset)
  }
  poses.clear()
  appearances.clear()
  for (const [id, pose] of nextPoses) {
    poses.set(id, pose)
  }
  for (const [id, appearance] of nextAppearances) {
    appearances.set(id, appearance)
  }
}

function adoptEnvironment(
  next: World,
  world: World,
  environment: ReturnType<typeof environmentState>,
): boolean {
  const first = world.tick === 0 && world.players.every((player) => player === null)
  const reset = environment.seed !== world.seed && next.tick < world.tick
  if (environment.seed === world.seed && next.tick < world.tick) {
    return false
  }
  if (!(first || reset) && environment.seed !== world.seed) {
    throw new Error('Invalid town epoch')
  }
  if (
    !(first || reset) &&
    environment.health.some((health, index) => health > (world.props[index] ?? 0))
  ) {
    throw new Error('Invalid town prop resurrection')
  }
  next.props = environment.health
  next.seed = environment.seed
  return true
}
