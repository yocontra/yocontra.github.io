/** Warm actual captured body/equation types without stepping the live world. */
import { Body, Plane, Vec3, type World } from 'cannon-es'
import { Vector3 } from 'three'
import { MAX_PLAYERS } from '../sim/constants.ts'
import type { CorpseRig } from './crowd/corpse-rig.ts'
import { CorpsePhysics } from './ragdoll-body.ts'
import { CorpseBroadphase } from './ragdoll-broadphase.ts'
import { RAGDOLL_STEP } from './ragdoll-joints.ts'
import { CorpseSolver } from './ragdoll-solver.ts'
import { createRagdollWorld } from './ragdoll-world.ts'

const primed = new WeakSet<World>()
interface Source {
  ids: readonly number[]
  capture: (id: number) => Promise<CorpseRig | null>
  valid: () => boolean
}

function floorAt(rig: CorpseRig): number {
  let height = Number.POSITIVE_INFINITY
  for (const link of rig.links) {
    if (link.key !== 'FootL' && link.key !== 'FootR') {
      continue
    }
    for (const sphere of link.anatomySpheres ?? []) {
      const center = sphere.center.clone().applyQuaternion(link.rotation).add(link.position)
      height = Math.min(height, center.y - sphere.radius)
    }
  }
  return Number.isFinite(height) ? height : Math.min(...rig.links.map((link) => link.start.y))
}

function available(world: World, source: Source): boolean {
  return (
    !primed.has(world) &&
    world.stepnumber === 0 &&
    world.solver instanceof CorpseSolver &&
    world.solver.equations.length === 0 &&
    source.valid()
  )
}

async function captureOne(
  source: Source,
  ids: readonly number[],
  index = 0,
): Promise<CorpseRig | null> {
  const id = ids[index]
  if (id === undefined || !source.valid()) {
    return null
  }
  const rig = await source.capture(id)
  return rig ?? captureOne(source, ids, index + 1)
}

export async function primeCorpseSolver(world: World, source: Source): Promise<void> {
  if (!available(world, source)) {
    return
  }
  const ids = [...new Set(source.ids)].filter(
    (value) => Number.isInteger(value) && value >= 0 && value < MAX_PLAYERS,
  )
  if (ids.length === 0) {
    return
  }
  const rig = await captureOne(source, ids)
  if (!rig) {
    return
  }
  if (!available(world, source)) {
    rig.dispose()
    return
  }
  const solver = world.solver as CorpseSolver
  const counters = { ...solver.stats }
  const isolated = createRagdollWorld()
  isolated.solver = solver
  isolated.doProfiling = false
  const floor = new Body({ mass: 0, shape: new Plane(), position: new Vec3(0, floorAt(rig), 0) })
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  isolated.addBody(floor)
  let physics: CorpsePhysics | null = null
  try {
    physics = new CorpsePhysics(isolated, rig, {
      velocity: rig.velocity.clone(),
      impulse: new Vector3(),
      step: RAGDOLL_STEP,
    })
    for (let step = 0; step < 2; step++) {
      physics.limitSpeed()
      isolated.step(RAGDOLL_STEP)
    }
    const rows =
      isolated.contacts.length +
      isolated.frictionEquations.length +
      physics.constraints.reduce((count, joint) => count + joint.equations.length, 0)
    solver.reserve(rows * MAX_PLAYERS, world.bodies.length + rig.links.length * MAX_PLAYERS)
    primed.add(world)
  } finally {
    if (physics) {
      physics.dispose()
    } else {
      rig.dispose()
    }
    solver.removeAllEquations()
    if (isolated.broadphase instanceof CorpseBroadphase) {
      isolated.broadphase.dispose()
    }
    Object.assign(solver.stats, counters, {
      kernelBytes: solver.stats.kernelBytes,
      primed: primed.has(world),
    })
  }
}
