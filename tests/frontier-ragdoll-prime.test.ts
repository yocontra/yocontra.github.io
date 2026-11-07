import { afterAll, beforeAll, expect, it } from 'bun:test'
import { file } from 'bun'
import { Equation, type World } from 'cannon-es'
import { Group, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  type CorpseRig,
  cloneCorpse,
  prepareCorpseFit,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { primeCorpseSolver } from '../src/experiments/out-west/ffa/scene/ragdoll-prime.ts'
import type { CorpseSolver } from '../src/experiments/out-west/ffa/scene/ragdoll-solver.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { buildGrid } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { Actor } from '../src/experiments/out-west/scene/actor.ts'

let actor: Actor
let props: Awaited<ReturnType<GLTFLoader['parseAsync']>>
let module: WebAssembly.Module
beforeAll(async () => {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const load = async (name: string) =>
    loader.parseAsync(
      await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(),
      '',
    )
  const [player, moves, base] = await Promise.all(['player', 'moves', 'casual'].map(load))
  if (!(player && moves && base)) {
    throw new Error('Actual assets missing')
  }
  markCharacterSlots(base)
  actor = new Actor(base, {
    base: 'casual',
    seed: 'solver-prime',
    clips: [...player.animations, ...moves.animations],
  })
  new Group().add(actor.root)
  actor.root.position.set(72, 8, 69)
  actor.root.scale.setScalar(1.25)
  actor.play('Idle_Gun_Pointing', 0)
  actor.update(0.37)
  prepareCorpseFit(actor)
  const geometry = actor.meshes[0]?.geometry
  if (!geometry) {
    throw new Error('Actual geometry missing')
  }
  ownGeometry(geometry)
  props = await loader.parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  module = await WebAssembly.compile(
    await file('src/experiments/out-west/ffa/scene/ragdoll-gs.wasm').arrayBuffer(),
  )
})
afterAll(() => {
  const geometry = actor.meshes[0]?.geometry
  if (geometry) {
    releaseGeometry(geometry)
  }
  actor.dispose()
})

function capture(disposed: () => void = () => undefined): CorpseRig {
  const geometry = actor.meshes[0]?.geometry
  if (!geometry) {
    throw new Error('Missing actual geometry')
  }
  const rig = cloneCorpse(actor, geometry, 'actual-loading-prime')
  const release = rig.dispose
  rig.dispose = () => {
    disposed()
    release()
  }
  return rig
}

function pool(native: boolean) {
  return new Ragdolls({
    root: new Group(),
    grid: buildGrid(),
    props,
    solverModule: native ? module : null,
    source: {
      captureCorpse: async () => capture(),
      suppressCorpse: () => true,
      releaseCorpse: () => undefined,
    },
  })
}

function state(world: World) {
  return {
    time: world.time,
    accumulator: world.accumulator,
    step: world.stepnumber,
    bodies: world.bodies.map((body) => ({
      id: body.id,
      index: body.index,
      mass: body.mass,
      type: body.type,
      transform: [...body.position.toArray(), ...body.quaternion.toArray()],
      velocity: [...body.velocity.toArray(), ...body.angularVelocity.toArray()],
      scratch: [...body.vlambda.toArray(), ...body.wlambda.toArray()],
      inertia: [
        ...body.inertia.toArray(),
        ...body.invInertiaWorld.elements,
        ...body.invInertiaWorldSolve.elements,
      ],
      sleep: [body.sleepState, body.timeLastSleepy],
      shapes: body.shapes.map((shape) => shape.id),
    })),
    constraints: world.constraints.map((joint) => [
      joint.id,
      ...joint.equations.map((row) => row.enabled),
    ]),
    contacts: world.contacts.map((row) => row.id),
    friction: world.frictionEquations.map((row) => row.id),
    bodyOverlap: [...world.bodyOverlapKeeper.current],
    shapeOverlap: [...world.shapeOverlapKeeper.current],
  }
}

it.each([false, true])(
  'warms owned actual bodies without changing the live town, panes or historical corpses (native=%s)',
  async (native) => {
    const live = pool(native)
    const old = new CorpsePhysics(live.world, capture(), {
      velocity: new Vector3(),
      impulse: new Vector3(),
    })
    const a = live.world.bodies[0]
    const b = old.parts[0]?.body
    if (!(a && b)) {
      throw new Error('Missing live bodies')
    }
    live.world.collisionMatrix.set(a, b, true)
    live.world.collisionMatrixPrevious.set(a, b, true)
    live.world.bodyOverlapKeeper.set(a.id, b.id)
    const before = state(live.world)
    const solver = live.world.solver as CorpseSolver
    const counters = { ...solver.stats }
    let captures = 0
    let disposals = 0
    try {
      await primeCorpseSolver(live.world, {
        ids: [0],
        valid: () => true,
        capture: () => {
          captures++
          return Promise.resolve(capture(() => disposals++))
        },
      })
      expect(state(live.world)).toEqual(before)
      expect(live.world.collisionMatrix.get(a, b)).toBe(1)
      expect(live.world.collisionMatrixPrevious.get(a, b)).toBe(1)
      expect(solver.equations).toHaveLength(0)
      expect(solver.stats.calls).toBe(counters.calls)
      expect(solver.stats.nativeCalls).toBe(counters.nativeCalls)
      expect(solver.stats.primed).toBe(true)
      expect(captures).toBe(1)
      expect(disposals).toBe(1)
      await primeCorpseSolver(live.world, {
        ids: [0],
        valid: () => true,
        capture: () => {
          captures++
          return Promise.resolve(capture())
        },
      })
      expect(captures).toBe(1)
    } finally {
      old.dispose()
      live.dispose()
    }
  },
)

it('releases an arriving rig when disposal/reconnect wins and permits a valid retry', async () => {
  const live = pool(true)
  let valid = true
  let disposed = 0
  let resolve: (rig: CorpseRig | null) => void = () => undefined
  const pending = primeCorpseSolver(live.world, {
    ids: [0],
    valid: () => valid,
    capture: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  valid = false
  resolve(capture(() => disposed++))
  await pending
  expect(disposed).toBe(1)
  expect((live.world.solver as CorpseSolver).stats.primed).toBe(false)
  await primeCorpseSolver(live.world, {
    ids: [0],
    valid: () => true,
    capture: async () => capture(() => disposed++),
  })
  expect(disposed).toBe(2)
  expect((live.world.solver as CorpseSolver).stats.primed).toBe(true)
  live.dispose()
})

it('skips suppressed historical slots and warms the next available actual actor', async () => {
  const live = pool(true)
  const calls: number[] = []
  let disposed = 0
  const before = state(live.world)
  try {
    await primeCorpseSolver(live.world, {
      ids: [0, 0, 1, 99],
      valid: () => true,
      capture: (id) => {
        calls.push(id)
        return Promise.resolve(id === 0 ? null : capture(() => disposed++))
      },
    })
    expect(calls).toEqual([0, 1])
    expect(disposed).toBe(1)
    expect((live.world.solver as CorpseSolver).stats.primed).toBe(true)
    expect(state(live.world)).toEqual(before)
  } finally {
    live.dispose()
  }
})

it('disposes a late captured rig without resurrecting a terminal live solver', async () => {
  const live = pool(true)
  let closed = false
  let disposed = 0
  let resolve: (value: CorpseRig | null) => void = () => undefined
  const pending = primeCorpseSolver(live.world, {
    ids: [0],
    valid: () => !closed,
    capture: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  closed = true
  live.dispose()
  resolve(capture(() => disposed++))
  await pending
  expect(disposed).toBe(1)
  expect(live.world.bodies).toHaveLength(0)
  expect((live.world.solver as CorpseSolver).stats.kernelBytes).toBe(0)
  expect((live.world.solver as CorpseSolver).stats.primed).toBe(false)
})

it('never borrows a solver with pending live rows or primes a world that has already advanced', async () => {
  const live = pool(false)
  const a = live.world.bodies[0]
  const b = live.world.bodies[1]
  if (!(a && b)) {
    throw new Error('Missing actual static bodies')
  }
  let calls = 0
  const source = {
    ids: [0],
    valid: () => true,
    capture: () => {
      calls++
      return Promise.resolve(capture())
    },
  }
  live.world.solver.addEquation(new Equation(a, b))
  await primeCorpseSolver(live.world, source)
  expect(calls).toBe(0)
  live.world.solver.removeAllEquations()
  live.world.step(1 / 120)
  await primeCorpseSolver(live.world, source)
  expect(calls).toBe(0)
  live.dispose()
})

it('keeps actual physical trajectories bit exact after the loading warmup and reservation', async () => {
  const cold = pool(true)
  const warm = pool(true)
  await primeCorpseSolver(warm.world, {
    ids: [0],
    valid: () => true,
    capture: async () => capture(),
  })
  const a = new CorpsePhysics(cold.world, capture(), {
    velocity: new Vector3(2, -16.2, 1),
    impulse: new Vector3(0, 0, -3),
  })
  const b = new CorpsePhysics(warm.world, capture(), {
    velocity: new Vector3(2, -16.2, 1),
    impulse: new Vector3(0, 0, -3),
  })
  try {
    for (let tick = 0; tick < 240; tick++) {
      a.limitSpeed()
      b.limitSpeed()
      cold.world.step(1 / 120)
      warm.world.step(1 / 120)
      const values = (physics: CorpsePhysics) =>
        physics.parts.flatMap((part) => [
          ...part.body.position.toArray(),
          ...part.body.quaternion.toArray(),
          ...part.body.velocity.toArray(),
          ...part.body.angularVelocity.toArray(),
          part.body.sleepState,
        ])
      expect(values(b)).toEqual(values(a))
      expect(warm.world.contacts.map((row) => row.multiplier)).toEqual(
        cold.world.contacts.map((row) => row.multiplier),
      )
    }
  } finally {
    a.dispose()
    b.dispose()
    cold.dispose()
    warm.dispose()
  }
})
