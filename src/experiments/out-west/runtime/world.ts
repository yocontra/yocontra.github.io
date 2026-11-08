import {
  AmmoPhysicsWorld,
  AppBase,
  AppOptions,
  CollisionComponentSystem,
  Entity,
  GraphNode,
  JointComponentSystem,
  Mesh,
  MeshInstance,
  Model,
  NullGraphicsDevice,
  RigidBodyComponentSystem,
  StandardMaterial,
  Vec3,
} from 'playcanvas'
import { BODY_HEIGHT, CROUCH_HEIGHT } from '../ffa/sim/constants.ts'
import { roofWalkAt } from '../ffa/sim/roofwalks.ts'
import { motorFrame, newMotion } from './abilities.ts'
import {
  type CollisionData,
  MAX_PLAYERS,
  neutralInput,
  PHYSICS_HZ,
  type PlayerInput,
  type PlayerState,
  SIMULATION_HZ,
} from './protocol.ts'

export interface SimulationOptions {
  joints?: boolean

  ammo: unknown
  collision: CollisionData
}
export function createSimulation(options: SimulationOptions) {
  Object.assign(globalThis, { Ammo: options.ammo })
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const config = new AppOptions()
  config.graphicsDevice = device
  config.componentSystems = [RigidBodyComponentSystem, CollisionComponentSystem]
  if (options.joints) {
    config.componentSystems.push(JointComponentSystem)
  }
  config.physicsWorld = new AmmoPhysicsWorld()
  app.init(config)
  const physics = (() => {
    const system = app.systems.rigidbody
    if (!system) {
      throw new Error('PlayCanvas physics system unavailable')
    }
    return system
  })()
  physics.timeScale = 0
  // The shared runtime supplies exact 60 Hz substeps; disable Bullet's second accumulator.
  physics.maxSubSteps = 0
  physics.gravity.set(0, -18, 0)
  const players = new Map<string, PlayerState>()
  const entities = new Map<string, Entity>()
  const lastButtons = new Map<string, number>()
  let disposed = false
  const colliders = addColliders(app, options.collision)
  function addPlayer(
    id: string,
    position: readonly [number, number, number] = [0, 3, 0],
  ): PlayerState {
    if (disposed) {
      throw new Error('Simulation disposed')
    }
    if (players.has(id)) {
      throw new Error('Duplicate player')
    }
    if (players.size >= MAX_PLAYERS) {
      throw new Error('Room full')
    }
    const entity = new Entity(id, app)
    entity.setPosition(...position)
    entity.addComponent('collision', { type: 'capsule', radius: 0.4, height: 1.8 })
    entity.addComponent('rigidbody', {
      type: 'dynamic',
      mass: 80,
      friction: 0,
      angularFactor: new Vec3(0, 0, 0),
      restitution: 0,
      linearDamping: 0,
    })
    app.root.addChild(entity)
    const state: PlayerState = {
      id,
      motion: newMotion(position[0], position[1] - 0.9, position[2]),
      x: position[0],
      y: position[1],
      z: position[2],
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      grounded: false,
      crouched: false,
      hp: 100,
      ammo: 6,
      seq: 0,
    }
    players.set(id, state)
    entities.set(id, entity)
    return state
  }
  function removePlayer(id: string) {
    entities.get(id)?.destroy()
    entities.delete(id)
    players.delete(id)
    lastButtons.delete(id)
  }
  function prepare(id: string, state: PlayerState, input: PlayerInput) {
    const entity = entities.get(id)
    const body = entity?.rigidbody
    if (!(entity && body)) {
      return
    }
    const position = entity.getPosition()
    const oldHeight = entity.collision?.height ?? 1.8
    const motion = state.motion ?? newMotion(state.x, state.y - 0.9, state.z)
    state.motion = motion
    motion.x = position.x
    motion.y = position.y - oldHeight / 2
    motion.z = position.z
    motion.vy = body.linearVelocity.y
    const cast = (from: readonly [number, number, number], to: readonly [number, number, number]) =>
      physics.raycastFirst(new Vec3(...from), new Vec3(...to), {
        filterCallback: (target: Entity) => target !== entity,
      })
    const hit = cast([motion.x, motion.y + 0.08, motion.z], [motion.x, motion.y - 0.15, motion.z])
    motion.grounded = hit !== null && hit.normal.y > 0.65
    const motor = motorFrame(motion, input, lastButtons.get(id) ?? 0, cast)
    let height = motor.height
    if (
      height > oldHeight &&
      cast([motion.x, motion.y + oldHeight, motion.z], [motion.x, motion.y + height, motion.z])
    ) {
      height = oldHeight
    }
    if (height !== oldHeight && entity.collision) {
      entity.collision.height = height
      body.teleport(position.x, position.y + (height - oldHeight) / 2, position.z)
    }
    body.type = motor.position ? 'kinematic' : 'dynamic'
    if (motor.position) {
      body.teleport(motor.position[0], motor.position[1] + height / 2, motor.position[2])
    }
    body.gravityScale = motor.gravity ? 1 : 0
    stepRiser({ body, position, motion, motor, height, cast })
    body.linearVelocity = new Vec3(motor.vx, motor.vy, motor.vz)
    state.yaw = input.yaw
    state.pitch = input.pitch
    state.seq = input.seq
    lastButtons.set(id, input.buttons)
  }
  function step(inputs: ReadonlyMap<string, PlayerInput>) {
    if (disposed) {
      throw new Error('Simulation disposed')
    }
    for (const [id, state] of players) {
      prepare(id, state, inputs.get(id) ?? neutralInput())
    }
    for (let i = 0; i < PHYSICS_HZ / SIMULATION_HZ; i++) {
      physics.step(1 / PHYSICS_HZ)
    }
    for (const [id, state] of players) {
      const entity = entities.get(id)
      const body = entity?.rigidbody
      if (!(entity && body)) {
        continue
      }
      const position = entity.getPosition()
      const velocity = body.linearVelocity
      state.x = position.x
      state.y = position.y + 0.9 - (entity.collision?.height ?? 1.8) / 2
      state.z = position.z
      state.vx = velocity.x
      state.vy = velocity.y
      state.vz = velocity.z
      state.crouched = (entity.collision?.height ?? BODY_HEIGHT) < BODY_HEIGHT
      updateMotion(state, entity, physics)
    }
  }
  function adopt(id: string, state: PlayerState) {
    if (restoreCapsule(entities.get(id), state)) {
      Object.assign(players.get(id) ?? {}, state)
    }
  }
  function dispose() {
    if (disposed) {
      return
    }
    disposed = true
    colliders.material.destroy()
    app.destroy()
    for (const mesh of colliders.meshes) {
      mesh.destroy()
    }
    players.clear()
    entities.clear()
    lastButtons.clear()
  }
  const castWorld = (ray: import('../ffa/sim/combat.ts').ShotRay) => castStatic(physics, ray)
  return { app, players, addPlayer, removePlayer, step, adopt, castWorld, dispose }
}
export type Simulation = ReturnType<typeof createSimulation>

function restoreCapsule(entity: Entity | undefined, state: PlayerState): boolean {
  if (!entity?.rigidbody) {
    return false
  }
  if (entity.collision && state.crouched !== undefined) {
    entity.collision.height = state.crouched ? CROUCH_HEIGHT : BODY_HEIGHT
  }
  entity.rigidbody.teleport(
    state.x,
    state.y - 0.9 + (entity.collision?.height ?? BODY_HEIGHT) / 2,
    state.z,
  )
  entity.rigidbody.linearVelocity = new Vec3(state.vx, state.vy, state.vz)
  return true
}

function stepRiser({
  body,
  position,
  motion,
  motor,
  height,
  cast,
}: {
  body: import('playcanvas').RigidBodyComponent
  position: Vec3
  motion: import('../ffa/sim/types.ts').MoveState
  motor: import('./abilities.ts').MotorFrame
  height: number
  cast: import('./abilities.ts').Cast
}) {
  // Step over shallow stair risers using engine support and head-clearance queries.
  const distance = Math.hypot(motor.vx, motor.vz)
  if (motion.grounded && distance > 0.1) {
    const x = motion.x + (motor.vx / distance) * 0.5
    const z = motion.z + (motor.vz / distance) * 0.5
    const riser = cast([motion.x, motion.y + 0.08, motion.z], [x, motion.y + 0.08, z])
    if (riser) {
      const support = cast([x, motion.y + 0.4, z], [x, motion.y + 0.02, z])
      if (
        support &&
        support.normal.y > 0.65 &&
        !cast([motion.x, motion.y + height, motion.z], [x, support.point.y + height, z])
      ) {
        body.teleport(position.x, support.point.y + height / 2, position.z)
      }
    }
  }
}

function updateMotion(
  state: PlayerState,
  entity: Entity,
  physics: import('playcanvas').RigidBodyComponentSystem,
) {
  if (state.motion) {
    const motion = state.motion
    motion.x = state.x
    motion.y = state.y - 0.9
    motion.z = state.z
    motion.vy = state.vy
    motion.airPeakY = Math.max(motion.airPeakY, motion.y)
    const hit = physics.raycastFirst(
      new Vec3(state.x, motion.y + 0.1, state.z),
      new Vec3(state.x, motion.y - 0.15, state.z),
      { filterCallback: (target: Entity) => target !== entity },
    )
    motion.grounded = hit !== null && hit.normal.y > 0.65
    state.grounded = motion.grounded
    motion.fallDamage = motion.grounded
      ? Math.max(0, Math.round((motion.airPeakY - (hit?.point.y ?? motion.y) - 9.6) * 10))
      : 0
    const deck = roofWalkAt(motion.roof)
    if (
      deck &&
      (motion.x < deck.x ||
        motion.x > deck.x + deck.w ||
        motion.z < deck.z ||
        motion.z > deck.z + deck.d)
    ) {
      motion.roof = 0
    }
    if (motion.grounded) {
      motion.airPeakY = motion.y
      motion.support = motion.y
    }
    motion.fallTicks = !motion.grounded && motion.vy < 0 ? motion.fallTicks + 1 : 0
  }
}

function addColliders(app: AppBase, collision: CollisionData) {
  const material = new StandardMaterial()
  const meshes: Mesh[] = []
  for (const box of collision.boxes) {
    const entity = new Entity('collision', app)
    entity.setPosition(...box.center)
    if (box.rotation) {
      entity.setEulerAngles(...box.rotation)
    }
    entity.addComponent('collision', { type: 'box', halfExtents: new Vec3(...box.halfExtents) })
    entity.addComponent('rigidbody', { type: 'static', friction: 0.8 })
    app.root.addChild(entity)
  }
  for (const source of collision.meshes) {
    const mesh = new Mesh(app.graphicsDevice)
    mesh.setPositions([...source.positions])
    mesh.setIndices([...source.indices])
    mesh.update()
    meshes.push(mesh)
    const model = new Model()
    model.graph = new GraphNode('collision-mesh')
    model.meshInstances = [new MeshInstance(mesh, material, model.graph)]
    const entity = new Entity('collision', app)
    entity.addComponent('collision', { type: 'mesh', model })
    entity.addComponent('rigidbody', { type: 'static', friction: 0.8 })
    app.root.addChild(entity)
  }

  return { meshes, material }
}

function castStatic(
  physics: import('playcanvas').RigidBodyComponentSystem,
  ray: import('../ffa/sim/combat.ts').ShotRay,
) {
  const from = new Vec3(ray.ox, ray.oy, ray.oz)
  const to = new Vec3(
    ray.ox + ray.dx * ray.maxT,
    ray.oy + ray.dy * ray.maxT,
    ray.oz + ray.dz * ray.maxT,
  )
  const hit = physics.raycastFirst(from, to, {
    filterCallback: (target: Entity) => target.name === 'collision',
  })
  return hit ? hit.point.distance(from) : null
}
