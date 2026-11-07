import { describe, expect, it } from 'bun:test'
import { Body, Box, Sphere, Vec3, World } from 'cannon-es'
import { Group, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import type { CorpseRig } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  CorpseBroadphase,
  tagCorpseBody,
} from '../src/experiments/out-west/ffa/scene/ragdoll-broadphase.ts'
import { SparseCorpseContacts } from '../src/experiments/out-west/ffa/scene/ragdoll-collisions.ts'
import {
  CORPSE_MAX_FALL,
  CORPSE_MAX_HORIZONTAL,
} from '../src/experiments/out-west/ffa/scene/ragdoll-motion.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'

const props = await new GLTFLoader().parseAsync(
  JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
  '',
)
const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }

function gridFixture() {
  const grid = buildGrid(layout)
  grid.tops.fill(0)
  grid.glass = [{ index: 0, axis: 0, at: 5, a0: 4, a1: 6, y0: 0.5, y1: 2 }]
  grid.decks = []
  grid.overheads = []
  grid.stairs = []
  return grid
}
function rig(onDispose: () => void): CorpseRig {
  const root = new Group()
  return {
    identity: 'life/actual-look',
    velocity: new Vector3(),
    root,
    links: [
      {
        key: 'Hips',
        parent: -1,
        position: new Vector3(2, 1, 2),
        rotation: new Quaternion(),
        start: new Vector3(2, 1, 2),
        end: new Vector3(2, 1.2, 2),
        radius: 0.1,
        mass: 12,
      },
    ],
    floor: { value: 0 },
    pose: () => undefined,
    dispose: () => {
      root.removeFromParent()
      onDispose()
    },
  }
}
function fixture() {
  const requests: ((value: CorpseRig | null) => void)[] = []
  const hidden = new Set<number>()
  const released: number[] = []
  const root = new Group()
  const source = {
    captureCorpse: () => new Promise<CorpseRig | null>((resolve) => requests.push(resolve)),
    suppressCorpse: (id: number) => {
      hidden.add(id)
      return true
    },
    releaseCorpse: (id: number) => {
      hidden.delete(id)
      released.push(id)
    },
  }
  const pool = new Ragdolls({ root, source, grid: gridFixture(), props, layout })
  return { pool, requests, hidden, released, root }
}

describe('actual-model ragdoll loading recovery', () => {
  it('recaptures the current dead life after a fast reconnect clears an awaited capture', async () => {
    const f = fixture()
    let freed = 0
    try {
      const kill = f.pool.killed(0, { x: 2, z: 2 }, null, { tick: 10 })
      const recovery = f.pool.recoverDead([{ id: 0, x: 2, y: 0, z: 2 }], 10, () => true)
      // A welcome clears the old life; the new full state is already ready before its clone resolves.
      f.pool.clear()
      f.requests[0]?.(rig(() => freed++))
      await kill
      expect(f.requests).toHaveLength(2)
      const recovered = rig(() => freed++)
      recovered.velocity.set(2, -3, 1)
      f.requests[1]?.(recovered)
      await recovery
      expect(freed).toBe(1)
      expect(f.pool.stats.corpses).toBe(1)
      expect(f.hidden.has(0)).toBe(true)
      expect(f.pool.world.bodies.find((body) => body.mass > 0)?.velocity.length()).toBe(0)
    } finally {
      f.pool.dispose()
    }
  })

  it('silently recovers a kill during loading, keeps valid physics and replays no hit impulse', async () => {
    const f = fixture()
    let freed = 0
    try {
      const loadingKill = f.pool.killed(0, { x: 2, z: 2 }, { x: 0, z: 2 })
      f.requests[0]?.(null)
      await loadingKill
      const recovery = f.pool.recoverDead([{ id: 0, x: 2, y: 0, z: 2 }], 10, () => true)
      await Promise.resolve()
      expect(f.requests).toHaveLength(2)
      f.requests[1]?.(rig(() => freed++))
      await recovery
      const body = f.pool.world.bodies.find((candidate) => candidate.mass > 0)
      expect(f.pool.stats.corpses).toBe(1)
      expect(body?.velocity.length()).toBe(0)
      await f.pool.recoverDead([{ id: 0, x: 2, y: 0, z: 2 }], 11, () => true)
      expect(f.requests).toHaveLength(2)
      expect(f.pool.world.bodies.find((candidate) => candidate.mass > 0)).toBe(body)
      expect(freed).toBe(0)
    } finally {
      f.pool.dispose()
    }
  })

  it('recovers a join while dead but rejects the clone if respawn wins the asynchronous recovery', async () => {
    const f = fixture()
    let stillDead = true
    let freed = 0
    try {
      const recovery = f.pool.recoverDead([{ id: 0, x: 2, y: 0, z: 2 }], 10, () => stillDead)
      await Promise.resolve()
      expect(f.requests).toHaveLength(1)
      stillDead = false
      f.pool.released(0)
      f.requests[0]?.(rig(() => freed++))
      await recovery
      expect(freed).toBe(1)
      expect(f.pool.stats.corpses).toBe(0)
      expect(f.hidden.size).toBe(0)
    } finally {
      f.pool.dispose()
    }
  })
})

describe('actual-model ragdoll lifecycle', () => {
  it.each([
    { label: 'mid-fall', velocity: new Vector3(2, -3, 1), expected: new Vector3(2, -3, 1) },
    {
      label: 'excess speed',
      velocity: new Vector3(100, -200, 3),
      expected: new Vector3(100, 0, 3).setLength(CORPSE_MAX_HORIZONTAL).setY(-CORPSE_MAX_FALL),
    },
    { label: 'nonfinite', velocity: new Vector3(Number.NaN, -3, 1), expected: new Vector3() },
  ])(
    'inherits a remote kill capture velocity with the existing finite/speed bounds: $label',
    async ({ velocity, expected }) => {
      const f = fixture()
      try {
        const captured = rig(() => undefined)
        captured.velocity.copy(velocity)
        const death = f.pool.killed(0, { x: 2, z: 2 }, null)
        f.requests[0]?.(captured)
        await death
        const body = f.pool.world.bodies.find((candidate) => candidate.mass > 0)
        expect(body?.velocity.x).toBeCloseTo(expected.x, 8)
        expect(body?.velocity.y).toBeCloseTo(expected.y, 8)
        expect(body?.velocity.z).toBeCloseTo(expected.z, 8)
      } finally {
        f.pool.dispose()
      }
    },
  )

  it('deduplicates kills and rejects a clone which resolves after respawn', async () => {
    const f = fixture()
    let freed = 0
    try {
      f.pool.killed(0, { x: 2, z: 2 }, null, { tick: 10 })
      f.pool.killed(0, { x: 2, z: 2 }, null, { tick: 10 })
      expect(f.requests).toHaveLength(1)
      f.pool.released(0)
      f.requests[0]?.(rig(() => freed++))
      await Promise.resolve()
      expect(freed).toBe(1)
      expect(f.hidden.size).toBe(0)
      expect(f.pool.stats.corpses).toBe(0)
      expect(f.root.children).toHaveLength(0)
    } finally {
      f.pool.dispose()
    }
  })

  it('keeps a real clone until a newer authoritative alive snapshot and releases resources once', async () => {
    const f = fixture()
    let freed = 0
    try {
      f.pool.killed(0, { x: 2, z: 2 }, null, { tick: 10 })
      f.requests[0]?.(rig(() => freed++))
      await Promise.resolve()
      expect(f.pool.stats).toMatchObject({ corpses: 1, bodies: 1, pending: 0 })
      expect(f.root.children).toHaveLength(1)
      f.pool.reconcileAlive([0], 10)
      expect(f.pool.stats.corpses).toBe(1)
      f.pool.reconcileAlive([0], 11)
      expect(f.pool.stats.corpses).toBe(0)
      expect(freed).toBe(1)
      f.pool.released(0)
      expect(freed).toBe(1)
    } finally {
      f.pool.dispose()
    }
  })

  it('never resurrects a disposed world through pane replacement, mutators or a late capture', async () => {
    const f = fixture()
    let freed = 0
    f.pool.killed(0, { x: 2, z: 2 }, null)
    f.pool.breakWindow(0)
    f.pool.dispose()
    f.pool.setBrokenWindows(new Set())
    f.pool.breakWindow(0)
    f.pool.killed(1, { x: 2, z: 2 }, null)
    f.pool.update(1 / 60)
    f.pool.reconcileAlive([1], 99)
    f.pool.setVisible(0, true)
    f.pool.dispose()
    f.requests[0]?.(rig(() => freed++))
    await Promise.resolve()
    expect(f.pool.world.bodies).toHaveLength(0)
    expect(f.requests).toHaveLength(1)
    expect(freed).toBe(1)
    expect(f.pool.focus(0, new Vector3())).toBeNull()
  })

  it('reconciles intact glass without physics-authoritative breaks and bounds invalid inputs', () => {
    const f = fixture()
    try {
      const count = f.pool.world.bodies.length
      f.pool.setBrokenWindows(new Set([0]))
      expect(f.pool.world.bodies).toHaveLength(count - 1)
      f.pool.setBrokenWindows(new Set())
      expect(f.pool.world.bodies).toHaveLength(count)
      f.pool.killed(32, { x: 2, z: 2 }, null)
      f.pool.killed(0, { x: Number.NaN, z: 2 }, null)
      f.pool.update(Number.POSITIVE_INFINITY)
      f.pool.update(-1)
      expect(f.requests).toHaveLength(0)
      expect(f.pool.stats.steps).toBe(0)
    } finally {
      f.pool.dispose()
    }
  })

  it('wakes a sleeping physical corpse when its supporting pane breaks or is replaced', async () => {
    const f = fixture()
    try {
      f.pool.killed(0, { x: 2, z: 2 }, null)
      const captured = rig(() => undefined)
      captured.links.push({
        key: 'Abdomen',
        parent: 0,
        position: new Vector3(2, 1.2, 2),
        rotation: new Quaternion(),
        start: new Vector3(2, 1.2, 2),
        end: new Vector3(2, 1.4, 2),
        radius: 0.1,
        mass: 5,
      })
      f.requests[0]?.(captured)
      await Promise.resolve()
      const bodies = f.pool.world.bodies.filter((candidate) => candidate.mass > 0)
      if (bodies.length !== 2) {
        throw new Error('Missing physical corpse')
      }
      const park = () =>
        bodies.forEach((body, index) => {
          body.position.set(index === 0 ? 4.5 : 5, 1.2, 5)
          body.aabbNeedsUpdate = true
          body.sleep()
        })
      park()
      f.pool.breakWindow(0)
      expect(bodies.every((body) => body.sleepState === Body.AWAKE)).toBe(true)
      f.pool.update(1 / 60)
      expect(f.pool.stats.steps).toBe(1)
      park()
      f.pool.setBrokenWindows(new Set())
      expect(bodies.every((body) => body.sleepState === Body.AWAKE)).toBe(true)
    } finally {
      f.pool.dispose()
    }
  })
})

it('restores already-dead physics after a running reconnect, once the replacement state and skin pose are ready', async () => {
  const f = fixture()
  let freed = 0
  const game = {
    ragdolls: f.pool,
    running: true,
    disposed: false,
    exited: false,
    connectionGeneration: 0,
    recoverAfterWelcome: false,
    net: {
      persistent: { ready: false },
      you: 0,
      alive: false,
      lastTick: 20,
      pred: { x: 2, y: 0, z: 2 },
      views: () => [],
    },
    showdowns: new Map(),
    resetWorldAudio: () => undefined,
    syncRoster: () => undefined,
  }
  Object.setPrototypeOf(game, FrontierGame.prototype)
  const method = (name: string) =>
    Reflect.apply(Reflect.get(FrontierGame.prototype, name), game, [])
  try {
    const first = f.pool.killed(0, { x: 2, z: 2 }, null)
    f.requests[0]?.(rig(() => freed++))
    await first
    method('onWelcome')
    expect(freed).toBe(1)
    method('recoverWelcomeCorpses')
    expect(f.requests).toHaveLength(1)
    // updateScene invokes this only after the new snapshot has updated the actual dressed pose.
    game.net.persistent.ready = true
    method('recoverWelcomeCorpses')
    method('recoverWelcomeCorpses')
    await Promise.resolve()
    expect(f.requests).toHaveLength(2)
    f.requests[1]?.(rig(() => freed++))
    await Promise.resolve()
    expect(f.pool.stats.corpses).toBe(1)
    expect(game.recoverAfterWelcome).toBe(false)
  } finally {
    f.pool.dispose()
  }
})

it.each([Body.SLEEPING, Body.SLEEPY, Body.AWAKE])(
  'wakes a connected sleeping limb when a corpse strikes a hip in state%i, then permits sleep again',
  async (state) => {
    const f = fixture()
    try {
      f.pool.world.gravity.set(0, 0, 0)
      const chain = rig(() => undefined)
      chain.links.push({
        key: 'Abdomen',
        parent: 0,
        position: new Vector3(2, 1.2, 2),
        rotation: new Quaternion(),
        start: new Vector3(2, 1.2, 2),
        end: new Vector3(2, 1.8, 2),
        radius: 0.1,
        mass: 5,
      })
      const first = f.pool.killed(0, { x: 2, z: 2 }, null)
      f.requests[0]?.(chain)
      await first
      const linked = f.pool.world.bodies.filter((body) => body.mass > 0)
      for (const body of linked) {
        body.sleep()
      }
      if (linked[0]) {
        linked[0].sleepState = state
      }
      const incoming = rig(() => undefined)
      for (const link of incoming.links) {
        link.position.x = 1.6
        link.start.x = 1.6
        link.end.x = 1.6
      }
      const second = f.pool.killed(1, { x: 1.6, z: 2 }, null, { velocity: new Vector3(3, 0, 0) })
      f.requests[1]?.(incoming)
      await second
      let anchored = 0
      let hit = false
      for (let frame = 0; frame < 45; frame++) {
        f.pool.update(1 / 60)
        hit ||= linked.some((body) => body.velocity.length() > 0.2)
        if (
          hit &&
          linked.some((body) => body.sleepState === Body.SLEEPING) &&
          linked.some((body) => body.sleepState !== Body.SLEEPING)
        ) {
          anchored++
        }
      }
      expect(hit).toBe(true)
      expect(anchored).toBe(0)
      expect(linked.every((body) => body.position.x > 2.01)).toBe(true)
      for (const body of f.pool.world.bodies) {
        body.velocity.setZero()
        body.angularVelocity.setZero()
      }
      for (let frame = 0; frame < 300; frame++) {
        f.pool.update(1 / 60)
      }
      expect(f.pool.stats.awake).toBe(0)
    } finally {
      f.pool.dispose()
    }
  },
)

describe('bounded cosmetic collision work', () => {
  it('stores only actual contacts instead of allocating static×static matrix entries', () => {
    const matrix = new SparseCorpseContacts()
    const a = new Body({ mass: 1 })
    const b = new Body({ mass: 1 })
    matrix.setNumObjects(5000)
    expect(matrix.matrix).toHaveLength(0)
    matrix.set(a, b, true)
    expect(matrix.get(b, a)).toBe(1)
    matrix.setNumObjects(6000)
    expect(matrix.get(a, b)).toBe(1)
    matrix.reset()
    expect(matrix.get(a, b)).toBe(0)
    matrix.set(a, b, true)
    matrix.set(b, a, false)
    expect(matrix.get(a, b)).toBe(0)
  })

  it('hashes exact statics, tracks removals and permits matching regions on different corpses', () => {
    const world = new World()
    const broadphase = new CorpseBroadphase(world)
    world.broadphase = broadphase
    const statics: Body[] = []
    for (let z = 0; z < 30; z++) {
      for (let x = 0; x < 30; x++) {
        const body = new Body({
          mass: 0,
          shape: new Box(new Vec3(0.5, 0.5, 0.5)),
          position: new Vec3(x * 3, 0.5, z * 3),
          collisionFilterGroup: 1,
          collisionFilterMask: 2,
        })
        world.addBody(body)
        statics.push(body)
      }
    }
    const owner = {}
    const moving = [0, 1, 2].map((index) => {
      const body = new Body({
        mass: 1,
        shape: new Sphere(0.4),
        position: new Vec3(0, 0.8, 0),
        collisionFilterGroup: 2,
        collisionFilterMask: 3,
      })
      tagCorpseBody(body, { owner: index < 2 ? owner : {}, index, parent: -1, region: 2 })
      world.addBody(body)
      return body
    })
    const pairs = () => {
      const left: Body[] = []
      const right: Body[] = []
      broadphase.collisionPairs(world, left, right)
      return left.map((body, i) => [body, right[i]])
    }
    try {
      const first = pairs()
      expect(first).toHaveLength(5) //3 static contacts,2 cross-corpse contacts
      expect(broadphase.stats.staticTests).toBeLessThan(100)
      const wall = statics[0]
      if (!wall) {
        throw new Error('Missing wall fixture')
      }
      world.removeBody(wall)
      expect(pairs()).toHaveLength(2)
      world.addBody(wall)
      expect(pairs()).toHaveLength(5)
      for (const body of moving) {
        body.position.set(7.99, 0.8, 7.99)
        body.aabbNeedsUpdate = true
      }
      expect(pairs()).toHaveLength(2)
    } finally {
      broadphase.dispose()
    }
  })
})
