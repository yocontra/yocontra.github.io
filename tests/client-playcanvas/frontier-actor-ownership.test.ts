import { expect, test as it } from 'bun:test'
import { Actors, type Appearance } from '../../src/experiments/out-west/client/actors.ts'
import { FrontierScene } from '../../src/experiments/out-west/client/frontier-scene.ts'
import type { NativeRagdolls } from '../../src/experiments/out-west/client/ragdolls.ts'
import { DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import {
  attachHeldWeapon,
  equippedActor,
} from '../../src/experiments/out-west/scene/native-equipment.ts'
import { firstPersonFixture } from './first-person-fixture.ts'

it('moves local equipment and shadow ownership after reconnect without replacing rider assets', async () => {
  const f = firstPersonFixture(true)
  const shadows: (string | undefined)[] = []
  Reflect.set(f.game, 'frontierShadows', {
    crowd: (_count: number, ownId: string | undefined) => shadows.push(ownId),
    registerRider: () => undefined,
  })
  const appearance: Appearance = { key: 'starter', loadout: DEFAULT_LOADOUT, dyes: {} }
  const ragdolls = { release: () => undefined } as unknown as NativeRagdolls
  const actors = new Actors(f.game, ragdolls, {
    appearance: () => appearance,
    world: () => undefined,
    showFailure: () => undefined,
  })
  const scene = new FrontierScene(f.game, new AbortController().signal)
  scene.actors = actors
  const ids = ['0', '1', '2']
  const players = new Map(ids.map((id) => [id, { ...f.request.player, id }]))
  const present = (selfId: string) => {
    scene.present({ selfId, players }, 1 / 60, { first: false, intent: neutralInput(), aim: false })
    f.app.batcher?.updateAll()
  }
  const batched = (actor: DuelActor) =>
    actor.root.findComponents('render').filter((render) => render.batchGroupId >= 0)
  try {
    const [previous, own, remote] = await Promise.all([
      equippedActor(f.game, appearance.loadout, {}, { local: true, carryDrawn: true }),
      equippedActor(f.game, appearance.loadout, {}, { carryDrawn: true }),
      equippedActor(f.game, appearance.loadout, {}, { carryDrawn: true }),
    ])
    // Seed the equipped native actors without loading a first-person viewmodel.
    Reflect.set(actors, 'ownId', '0')
    const assign = Reflect.get(actors, 'assign') as (
      id: string,
      actor: DuelActor,
      key: string,
    ) => void
    assign.call(actors, '0', previous, appearance.key)
    assign.call(actors, '1', own, appearance.key)
    assign.call(actors, '2', remote, appearance.key)
    present('0')
    expect(batched(previous)).toHaveLength(0)
    expect(batched(own)).toHaveLength(3)
    const stable = batched(remote)
    expect(stable).toHaveLength(3)
    const held = attachHeldWeapon(f.game, own, 'rifle', DYNAMIC_ASSETS['held-rifle'].url)

    present('1')
    expect(shadows.at(-1)).toBe('1')
    expect(batched(previous)).toHaveLength(3)
    expect(batched(own)).toHaveLength(0)
    expect(batched(remote)).toEqual(stable)
    expect([previous, own, remote].every((rider) => rider.root.parent === f.game.stage)).toBe(true)

    f.requests[0]?.finish()
    await held
    expect(batched(own)).toHaveLength(0)
    expect(own.weaponMounts.some((mount) => mount.weapon === 'rifle')).toBe(true)

    present('0')
    expect(shadows.at(-1)).toBe('0')
    expect(batched(previous)).toHaveLength(0)
    expect(batched(own)).toHaveLength(4)
    expect(batched(remote)).toEqual(stable)
  } finally {
    scene.destroy()
    f.dispose()
  }
})
