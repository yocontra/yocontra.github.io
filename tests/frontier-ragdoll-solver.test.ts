import { beforeAll, describe, expect, it } from 'bun:test'
import { file } from 'bun'
import {
  Body,
  ContactEquation,
  Equation,
  GSSolver,
  Plane,
  PointToPointConstraint,
  Sphere,
  Vec3,
  World,
} from 'cannon-es'
import { Group, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../src/experiments/out-west/data/outlaws.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  cloneCorpse,
  prepareCorpseFit,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { CorpseBroadphase } from '../src/experiments/out-west/ffa/scene/ragdoll-broadphase.ts'
import { CorpseSolver } from '../src/experiments/out-west/ffa/scene/ragdoll-solver.ts'
import { Actor } from '../src/experiments/out-west/scene/actor.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const models = new Map<BodyKey, GLTF>()
let player: GLTF
let moves: GLTF
beforeAll(async () => {
  const load = async (name: string) =>
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(
        await file(
          new URL(`../public/experiments/out-west/3d/models/${name}.glb`, import.meta.url),
        ).arrayBuffer(),
        '',
      )
  ;[player, moves] = await Promise.all([load('player'), load('moves')])
  await Promise.all(
    bases.map(async (base) => {
      const model = await load(base)
      markCharacterSlots(model)
      models.set(base, model)
    }),
  )
})

function worldFor(solver: GSSolver): World {
  const world = new World({ gravity: new Vec3(0, -9.81, 0), allowSleep: true })
  world.broadphase = new CorpseBroadphase(world)
  solver.iterations = 24
  solver.tolerance = 1e-7
  world.solver = solver
  world.defaultContactMaterial.friction = 0.72
  world.defaultContactMaterial.restitution = 0.02
  world.defaultContactMaterial.contactEquationStiffness = 1e8
  const floor = new Body({ mass: 0, shape: new Plane() })
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  world.addBody(floor)
  return world
}

function difference(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    return Number.POSITIVE_INFINITY
  }
  let error = 0
  for (let i = 0; i < a.length; i++) {
    error = Math.max(error, Math.abs((a[i] ?? Number.NaN) - (b[i] ?? Number.NaN)))
  }
  return error
}

function bodyState(body: Body): number[] {
  return [
    ...body.position.toArray(),
    ...body.quaternion.toArray(),
    ...body.velocity.toArray(),
    ...body.angularVelocity.toArray(),
    body.sleepState,
  ]
}

function contacts(world: World): number[] {
  return world.contacts.flatMap((row) => [
    ...row.ri.toArray(),
    ...row.rj.toArray(),
    ...row.ni.toArray(),
    row.multiplier,
  ])
}

describe.each(bases)('cached GS on the actual %s model', (base) => {
  it('matches stock poses, velocities, contact equations and impulses through fast falls at different yaws', () => {
    const model = models.get(base)
    if (!model) {
      throw new Error(`Missing ${base} asset`)
    }
    for (const clip of ['Idle', 'Run', 'Idle_Gun_Pointing', 'Crouch_Idle'] as const) {
      const actor = new Actor(model, {
        base,
        clips: [...player.animations, ...moves.animations],
        seed: 'solver-equivalence',
      })
      new Group().add(actor.root)
      actor.root.scale.setScalar(1.25)
      actor.root.position.set(0, 8, 0)
      actor.play(clip, 0)
      actor.update(0.37)
      prepareCorpseFit(actor)
      const geometry = actor.meshes[0]?.geometry
      if (!geometry) {
        throw new Error('Actual skin missing')
      }
      ownGeometry(geometry)
      try {
        for (const yaw of [0, 0.73]) {
          actor.root.rotation.y = yaw
          actor.root.updateMatrixWorld(true)
          const stock = worldFor(new GSSolver())
          const cached = worldFor(new CorpseSolver())
          const build = (world: World) =>
            new CorpsePhysics(world, cloneCorpse(actor, geometry, `${base}/${clip}`), {
              velocity: new Vector3(2, -16.2, 1),
              impulse: new Vector3(0, 0, -3),
            })
          const a = build(stock)
          const b = build(cached)
          let error = 0
          try {
            error = trajectoryError(a, b, stock, cached)
            // Operation order is retained, so the complete physical trajectory is bit exact.
            expect(error).toBe(0)
          } finally {
            a.dispose()
            b.dispose()
          }
        }
      } finally {
        releaseGeometry(geometry)
        actor.dispose()
      }
    }
  }, 30_000)
})

it('keeps custom equation iteration overrides on Cannon’s stock path', () => {
  let calls = 0
  const run = (solver: GSSolver) => {
    const world = new World()
    const a = new Body({ mass: 1, shape: new Sphere(0.1) })
    const b = new Body({ mass: 2, shape: new Sphere(0.1) })
    world.addBody(a)
    world.addBody(b)
    a.linearFactor.set(0.5, 1, 0)
    const row = new Equation(a, b)
    row.jacobianElementA.spatial.set(1, 0, 0)
    row.jacobianElementB.spatial.set(-1, 0, 0)
    row.computeB = () => 1
    const add = row.addToWlambda.bind(row)
    row.addToWlambda = (delta) => {
      calls++
      add(delta)
    }
    solver.addEquation(row)
    solver.solve(1 / 120, world)
    return [...bodyState(a), ...bodyState(b), row.multiplier]
  }
  expect(run(new CorpseSolver())).toEqual(run(new GSSolver()))
  expect(calls).toBeGreaterThan(0)
})

function trajectoryError(a: CorpsePhysics, b: CorpsePhysics, stock: World, cached: World): number {
  let error = 0
  for (let step = 0; step < 240; step++) {
    a.limitSpeed()
    b.limitSpeed()
    stock.step(1 / 120)
    cached.step(1 / 120)
    for (let part = 0; part < a.parts.length; part++) {
      const left = a.parts[part]?.body
      const right = b.parts[part]?.body
      if (!(left && right)) {
        throw new Error('A solver lost an actual body part')
      }
      error = Math.max(error, difference(bodyState(left), bodyState(right)))
    }
    error = Math.max(error, difference(contacts(stock), contacts(cached)))
    error = Math.max(
      error,
      difference(
        a.constraints.flatMap((joint) => joint.equations.map((row) => row.multiplier)),
        b.constraints.flatMap((joint) => joint.equations.map((row) => row.multiplier)),
      ),
    )
  }

  return error
}

it('falls back when a custom RHS changes a previously prepared row’s force bound', () => {
  const run = (solver: GSSolver) => {
    const world = new World()
    const a = new Body({ mass: 0, shape: new Sphere(0.1) })
    const b = new Body({ mass: 1, shape: new Sphere(0.1) })
    b.position.y = -0.1
    world.addBody(a)
    world.addBody(b)
    const first = new ContactEquation(a, b, 1)
    first.ni.set(0, 1, 0)
    const second = new ContactEquation(a, b, 0)
    second.ni.set(0, 1, 0)
    const compute = second.computeB.bind(second)
    second.computeB = (dt) => {
      first.maxForce = 0
      return compute(dt)
    }
    solver.addEquation(first)
    solver.addEquation(second)
    solver.iterations = 24
    solver.solve(1 / 120, world)
    return { velocity: b.velocity.toArray(), impulse: first.multiplier }
  }
  expect(run(new CorpseSolver())).toEqual(run(new GSSolver()))
})

function transitions(solver: GSSolver) {
  const world = worldFor(solver)
  const pane = new Body({ mass: 0, shape: new Sphere(0.1), position: new Vec3(8, 1, 0) })
  const moving = new Body({ mass: 1, shape: new Sphere(0.1), position: new Vec3(0, 2, 0) })
  const carrier = new Body({
    mass: 2,
    type: Body.KINEMATIC,
    shape: new Sphere(0.1),
    position: new Vec3(3, 1, 0),
  })
  pane.linearFactor.set(1, -1, 0.5)
  pane.angularFactor.set(0.5, 1, -1)
  pane.velocity.set(-0, 0, -0)
  world.addBody(pane)
  world.addBody(moving)
  world.addBody(carrier)
  const joint = new PointToPointConstraint(moving, new Vec3(), carrier, new Vec3(-3, 1, 0))
  world.addConstraint(joint)
  return { world, moving, carrier, pane, joint }
}

type Transition = ReturnType<typeof transitions>
function change(state: Transition, phase: number): void {
  const { moving, carrier, pane, world } = state
  if (phase === 1) {
    moving.sleep()
  }
  if (phase === 2) {
    moving.wakeUp()
    carrier.type = Body.DYNAMIC
    carrier.updateMassProperties()
  }
  if (phase === 3) {
    carrier.type = Body.KINEMATIC
    carrier.velocity.set(0.1, 0, 0.3)
  }
  if (phase === 4 || phase === 5) {
    moving.type = phase === 4 ? Body.STATIC : Body.DYNAMIC
    moving.mass = phase === 4 ? 0 : 1
    moving.updateMassProperties()
  }
  if (phase === 6) {
    world.removeBody(pane)
  }
  if (phase === 7) {
    world.addBody(pane)
  }
}

it('matches stock zero-response state across sleep, body-type and pane membership changes', () => {
  const stock = transitions(new GSSolver())
  const cached = transitions(new CorpseSolver())
  for (let phase = 0; phase < 8; phase++) {
    change(stock, phase)
    change(cached, phase)
    for (let step = 0; step < 20; step++) {
      stock.world.step(1 / 120)
      cached.world.step(1 / 120)
      const state = (value: Transition) =>
        value.world.bodies.flatMap((body) => [
          ...bodyState(body),
          ...body.vlambda.toArray(),
          ...body.wlambda.toArray(),
          body.invMassSolve,
          ...body.invInertiaWorldSolve.elements,
        ])
      expect(state(cached)).toEqual(state(stock))
      expect(cached.joint.equations.map((row) => row.multiplier)).toEqual(
        stock.joint.equations.map((row) => row.multiplier),
      )
    }
  }
})
