import { expect, it } from 'bun:test'
import { Group, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { place, run, testWorld } from '../api/src/town/test-helpers.ts'
import { BTN_JUMP } from '../src/experiments/out-west/contract/town.ts'
import type { Sink } from '../src/experiments/out-west/ffa/client/events.ts'
import { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import type { CorpseRig } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { DT } from '../src/experiments/out-west/ffa/sim/constants.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import type { MoveState } from '../src/experiments/out-west/ffa/sim/types.ts'

const props = await new GLTFLoader().parseAsync(
  JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
  '',
)
const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }
async function captureThroughGame(
  move: MoveState,
  velocity: Vector3,
  self: boolean,
): Promise<Vector3> {
  const rig: CorpseRig = {
    identity: 'rendered-life',
    root: new Group(),
    velocity: velocity.clone(),
    floor: { value: 0 },
    links: [
      {
        key: 'Hips',
        parent: -1,
        position: new Vector3(2, 1, 2),
        start: new Vector3(2, 1, 2),
        end: new Vector3(2, 1.2, 2),
        rotation: new Quaternion(),
        radius: 0.1,
        mass: 10,
      },
    ],
    pose: () => undefined,
    dispose: () => undefined,
  }
  const pool = new Ragdolls({
    root: new Group(),
    grid: buildGrid(layout),
    props,
    layout,
    source: {
      captureCorpse: () => Promise.resolve(rig),
      suppressCorpse: () => true,
      releaseCorpse: () => undefined,
    },
  })
  const state = {
    net: { you: self ? 0 : 1, pred: move, prev: { ...move }, lastTick: 20 },
    crowdList: [{ id: 0, vx: velocity.x, vz: velocity.z }],
    ragdolls: pool,
  }
  const sink: Sink = Reflect.apply(Reflect.get(FrontierGame.prototype, 'makeSink'), state, [])
  try {
    sink.ragdollKilled(0, { x: 2, y: 0, z: 2 }, null, null)
    await Promise.resolve()
    const body = pool.world.bodies.find((part) => part.mass > 0)
    if (!body) {
      throw new Error('Missing actual physics body after the Game kill sink')
    }
    return new Vector3(body.velocity.x, body.velocity.y, body.velocity.z)
  } finally {
    pool.dispose()
  }
}

it.each([false, true])(
  'inherits a real 2.2 m mantle arc through the Game kill sink for self=%s, even after prediction stops',
  async (self) => {
    const world = testWorld()
    const player = place(world, 20.5, 57.5)
    run(world, 20, { [player.id]: () => ({ moveX: 127 }) })
    run(world, 1, { [player.id]: () => ({ buttons: BTN_JUMP }) })
    run(world, 1)
    const before = new Vector3(player.x, player.y, player.z)
    run(world, 1)
    const velocity = new Vector3(player.x, player.y, player.z).sub(before).divideScalar(DT)
    expect(velocity.y).toBeGreaterThan(10)
    expect(player.vy).toBe(0)
    // Net.reconcile may stopMoves before the lethal event reaches the scene. The last rendered
    // skin still belongs to the committed arc; it is the descriptor captureCorpse snapshots.
    const stopped = { ...player, mantleTicks: 0, climbTicks: 0, jumpTicks: 0, vaultStep: 0 }
    const inherited = await captureThroughGame(stopped, velocity, self)
    expect(inherited.distanceTo(velocity)).toBeLessThan(1e-8)
  },
)

it('retains the last visible ballistic velocity for self after dead prediction stops', async () => {
  const world = testWorld()
  const player = place(world, 20, 64)
  Object.assign(player, { y: 8, support: 0, grounded: false, vy: 0, airPeakY: 8 })
  run(world, 12)
  const lastVisible = new Vector3(2, player.vy, 1)
  const inherited = await captureThroughGame({ ...player, vy: 0 }, lastVisible, true)
  expect(inherited.toArray()).toEqual(lastVisible.toArray())
  expect(inherited.y).toBeCloseTo(-10.8, 8)
})
