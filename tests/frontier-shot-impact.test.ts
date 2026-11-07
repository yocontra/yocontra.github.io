import { describe, expect, it } from 'bun:test'
import { place, run, testWorld } from '../api/src/town/test-helpers.ts'
import {
  BTN_AIM,
  BTN_FIRE,
  CONTRACT_VERSION,
  EV_KILL,
  EV_SHOT,
  MSG_FULL_RESET,
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../src/experiments/out-west/contract/town.ts'
import { NetClient } from '../src/experiments/out-west/ffa/client/net.ts'
import {
  type RagdollImpact,
  ShotImpacts,
} from '../src/experiments/out-west/ffa/client/shot-impact.ts'
import { Writer } from '../src/experiments/out-west/ffa/sim/bytes.ts'
import { shotCoord, toWireEvent } from '../src/experiments/out-west/ffa/sim/codec-events.ts'
import { ClientStream, snapshotFor } from '../src/experiments/out-west/ffa/sim/snapshot.ts'

const kill = toWireEvent({ type: 'kill', victim: 1, killer: 0, flags: 0, bounty: 0 })
const shot = (flags = SHOT_HIT) =>
  toWireEvent({
    type: 'shot',
    shooter: 0,
    target: 1,
    aim: 0,
    flags,
    range: 5,
    x: 20,
    z: 64,
    y: 40,
    origin: { x: 20, y: 7, z: 64 },
    end: { x: 24, y: 4, z: 64 },
    pellets: [],
  })
const welcome = JSON.stringify({
  type: 'welcome',
  contractVersion: CONTRACT_VERSION,
  you: 0,
  lobbyId: 'impact-test',
  banked: 0,
  roster: [],
})

function lethalSnapshot() {
  const world = testWorld()
  const shooter = place(world, 20, 64)
  const victim = place(world, 21.5, 64)
  for (const player of [shooter, victim]) {
    player.aim = 0
    player.y = 4
    player.grounded = false
  }
  victim.hp = 1
  run(world, 1)
  run(world, 1, { [shooter.id]: () => ({ aim: 0, buttons: BTN_FIRE | BTN_AIM }) })
  const report = world.events.find((event) => event.type === 'shot')
  if (report?.type !== 'shot' || victim.alive) {
    throw new Error('actual elevated shot did not kill its target')
  }
  const bytes = snapshotFor(
    world,
    { viewer: shooter, stream: new ClientStream() },
    { banked: 0, events: world.events },
    new Writer(),
  )
  return { world, report, bytes }
}

describe('Frontier authoritative killing-shot context', () => {
  it('prepasses actual elevated lethal shot geometry before the earlier kill event dispatches', () => {
    const f = lethalSnapshot()
    expect(f.world.events.findIndex((event) => event.type === 'kill')).toBeLessThan(
      f.world.events.findIndex((event) => event.type === 'shot'),
    )
    let impact: RagdollImpact | null = null
    const client = new NetClient({
      onWelcome: () => undefined,
      onControl: () => undefined,
      onPredictedShot: () => undefined,
      onEvent: (event) => {
        if (event.type === EV_KILL) {
          impact = client.takeRagdollImpact(event.victim, event.killer, performance.now())
        }
      },
    })
    client.handle(welcome, performance.now())
    client.handle(f.bytes.slice().buffer, performance.now())
    const wire = toWireEvent(f.report)
    if (wire.type !== EV_SHOT) {
      throw new Error('missing shot wire geometry')
    }
    expect(impact).toMatchObject({
      weapon: WEAPON_REVOLVER,
      point: { x: shotCoord(wire.ex), y: shotCoord(wire.ey), z: shotCoord(wire.ez) },
    })
    expect(f.report.end.y).toBeGreaterThan(4)
    expect(client.takeRagdollImpact(1, 0, performance.now())).toBeNull()
  })

  it.each([
    [SHOT_HIT, WEAPON_REVOLVER],
    [SHOT_HIT | SHOT_RIFLE, WEAPON_RIFLE],
    [SHOT_HIT | SHOT_SHOTGUN, WEAPON_SHOTGUN],
  ] as const)('keeps 3D point, unit direction and weapon for flags%j', (flags, weapon) => {
    const cache = new ShotImpacts()
    cache.remember([kill, shot(flags)], 7, 100)
    expect(cache.take(1, 0, 7, 120)).toEqual({
      point: { x: 24, y: 4, z: 64 },
      direction: { x: 0.8, y: -0.6, z: 0 },
      weapon,
    })
  })

  it('does not reuse a nonlethal shot for a subsequent non-shot death by the same killer', () => {
    const cache = new ShotImpacts()
    cache.remember([shot(), kill], 7, 100)
    expect(cache.take(1, 0, 7, 120)).toBeNull()
  })

  it('rejects degenerate or nonfinite ray geometry instead of passing it into physics', () => {
    const cache = new ShotImpacts()
    const report = shot()
    if (report.type !== EV_SHOT) {
      throw new Error('missing shot fixture')
    }
    for (const invalid of [
      { ...report, ox: report.ex, oy: report.ey, oz: report.ez },
      { ...report, ex: Number.NaN },
      { ...report, oy: Number.POSITIVE_INFINITY },
    ]) {
      cache.remember([kill, invalid], 7, 100)
      expect(cache.take(1, 0, 7, 100)).toBeNull()
    }
  })

  it('consumes once, matches killer/tick and expires after500ms', () => {
    const cache = new ShotImpacts()
    for (const [killer, tick, now] of [
      [2, 7, 100],
      [0, 8, 100],
      [0, 7, 601],
      [0, 7, 99],
    ] as const) {
      cache.remember([kill, shot()], 7, 100)
      expect(cache.take(1, killer, tick, now)).toBeNull()
      expect(cache.take(1, 0, 7, 100)).toBeNull()
    }
  })
})

describe('Frontier killing-shot lifecycle', () => {
  it.each(['reset', 'baseline', 'welcome', 'remove', 'terminal'])(
    'drops retained hit context on%j',
    (reason) => {
      const f = lethalSnapshot()
      const client = new NetClient({
        onWelcome: () => undefined,
        onControl: () => undefined,
        onPredictedShot: () => undefined,
        onEvent: () => undefined,
      })
      const now = performance.now()
      client.handle(welcome, now)
      client.handle(f.bytes.slice().buffer, now)
      switch (reason) {
        case 'reset':
          client.reset()
          break
        case 'baseline':
          client.handle(Uint8Array.of(MSG_FULL_RESET).buffer, now)
          break
        case 'welcome':
          client.handle(welcome, now)
          break
        case 'remove':
          client.handle(JSON.stringify({ type: 'roster_remove', id: 1 }), now)
          break
        default:
          client.handle(welcome.replace('"contractVersion":10', '"contractVersion":9'), now)
      }
      expect(client.takeRagdollImpact(1, 0, now)).toBeNull()
    },
  )
})
