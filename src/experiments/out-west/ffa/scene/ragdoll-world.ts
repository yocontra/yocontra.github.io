/** The contact/solver policy shared by live physics and its isolated loading warmup. */
import { Vec3, World } from 'cannon-es'
import { CorpseBroadphase } from './ragdoll-broadphase.ts'
import { SparseCorpseContacts } from './ragdoll-collisions.ts'
import { CorpseSolver } from './ragdoll-solver.ts'

export function createRagdollWorld(module?: WebAssembly.Module | null): World {
  const world = new World({ gravity: new Vec3(0, -9.81, 0), allowSleep: true })
  world.broadphase = new CorpseBroadphase(world)
  world.collisionMatrix = new SparseCorpseContacts()
  world.collisionMatrixPrevious = new SparseCorpseContacts()
  world.doProfiling = import.meta.env.DEV || import.meta.env.PUBLIC_OW_PERF_HARNESS === '1'
  const solver = new CorpseSolver(module)
  solver.iterations = 24
  solver.tolerance = 1e-7
  world.solver = solver
  world.defaultContactMaterial.friction = 0.72
  world.defaultContactMaterial.restitution = 0.02
  world.defaultContactMaterial.contactEquationStiffness = 1e8
  return world
}
