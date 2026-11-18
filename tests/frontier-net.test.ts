import { describe, expect, it } from 'bun:test'
import {
  domainInput,
  type FrontierSession,
} from '../src/experiments/out-west/client/frontier-session.ts'
import {
  type ConnectionNotice,
  reconnectableSession,
} from '../src/experiments/out-west/client/reconnect-session.ts'
import { assertCompatibility } from '../src/experiments/out-west/client/state.ts'
import { COLLISION_VERSION } from '../src/experiments/out-west/content/manifest.ts'
import {
  TOWN_CLOSE_REPLACED,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../src/experiments/out-west/contract/town.ts'
import { firePickupWeapon } from '../src/experiments/out-west/ffa/sim/pickups.ts'
import { createWorld } from '../src/experiments/out-west/ffa/sim/state.ts'
import { addPlayer } from '../src/experiments/out-west/ffa/sim/world.ts'
import {
  Buttons,
  neutralInput,
  PROTOCOL_VERSION,
} from '../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState } from '../src/experiments/out-west/runtime/schema.ts'

describe('Frontier native welcome compatibility', () => {
  it('accepts the exact protocol and collision content the client predicts', () => {
    const state = new FrontierState()
    state.protocol = PROTOCOL_VERSION
    state.content = COLLISION_VERSION
    expect(() => assertCompatibility(state)).not.toThrow()
  })
  it.each([0, PROTOCOL_VERSION + 1, -1])(
    'rejects incompatible protocol %d before prediction',
    (protocol) => {
      const state = new FrontierState()
      state.protocol = protocol
      state.content = COLLISION_VERSION
      expect(() => assertCompatibility(state)).toThrow('updated')
    },
  )
  it('rejects stale collision content even when the protocol matches', () => {
    const state = new FrontierState()
    state.protocol = PROTOCOL_VERSION
    state.content = 'previous-town'
    expect(() => assertCompatibility(state)).toThrow('updated')
  })
  it.each([
    [0, 49_152],
    [-Math.PI / 2, 0],
    [Math.PI, 16_384],
    [Math.PI / 2, 32_768],
  ])('maps camera yaw %f to the same domain firing direction', (yaw, aim) => {
    const frame = domainInput({ ...neutralInput(), yaw }, 1, 20)
    expect(frame.aim).toBe(aim)
  })
  it('retains integer pitch and every gameplay button in the shared input intent', () => {
    const buttons = Object.values(Buttons).reduce((all, bit) => all | bit, 0)
    const frame = domainInput(
      { ...neutralInput(), buttons, pitch: ((1.6 / 127) * Math.PI) / 2, moveX: 0.5 },
      31,
      200,
    )
    expect(frame.pitch).toBe(2)
    expect(frame.buttons).toBe(buttons)
    expect(frame.seq).toBe(31)
    expect(frame.viewTime).toBe(200)
    expect(frame.moveX).toBe(64)
  })
})

it('a replacement with the same account does not cause the older tab to rejoin', async () => {
  const states: string[] = []
  let notify: ConnectionNotice | undefined
  let connections = 0
  let sends = 0
  const connect = (listener: ConnectionNotice): Promise<FrontierSession> => {
    const previous = notify
    notify = listener
    connections++
    previous?.('closed', 'Joined from somewhere else.', TOWN_CLOSE_REPLACED)
    const noOp = (): void => undefined
    return Promise.resolve({
      selfId: '0',
      selfSlot: 0,
      world: createWorld(7),
      banked: 0,
      practice: false,
      lobbyId: 'perdition',
      players: new Map(),
      subscribe: () => noOp,
      subscribeControl: () => noOp,
      control: () => {
        sends++
      },
      update: noOp,
      dispose: noOp,
    })
  }
  const first = await reconnectableSession(connect, (state) => states.push(state))
  const second = await reconnectableSession(connect, (state) => states.push(state))
  try {
    first.control('{}')
    expect(sends).toBe(0)
    second.control('{}')
    expect(sends).toBe(1)
    expect(connections).toBe(2)
    expect(states).toEqual(['open', 'closed', 'open'])
  } finally {
    first.dispose()
    second.dispose()
  }
})

it.each([WEAPON_RIFLE, WEAPON_SHOTGUN])(
  'pickup weapon %d keeps its spread, bloom and pellets on the last round',
  (weapon) => {
    function fire(rounds: number) {
      const world = createWorld(7)
      const id = addPlayer(world, {
        accountId: 'self',
        name: 'Rider',
        level: 1,
        prestige: 0,
        bot: false,
      })
      const player = world.players[id]
      if (!player) {
        throw new Error('Missing fixture rider')
      }
      Object.assign(player, { x: 10, y: 0, z: 10, weapon, weaponRounds: rounds })
      firePickupWeapon(world, player, 0, world.tick)
      const shot = world.events.find((event) => event.type === 'shot')
      if (!shot) {
        throw new Error('The pickup did not fire')
      }
      return { shot, bloom: player.bloom, nextWeapon: player.weapon }
    }
    const before = fire(2)
    const last = fire(1)
    expect(last.shot).toEqual(before.shot)
    expect(last.bloom).toBe(before.bloom)
    expect(before.nextWeapon).toBe(weapon)
    expect(last.nextWeapon).toBe(WEAPON_REVOLVER)
  },
)
