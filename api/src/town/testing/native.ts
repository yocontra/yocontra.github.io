/** Native simulation fixtures; tests never use the removed grid movement solver. */
import { afterEach } from 'bun:test'
import { file } from 'bun'
import type { WorldOptions } from '../../../../src/experiments/out-west/ffa/sim/state.ts'
import { initializeAmmo } from '../../../../src/experiments/out-west/runtime/ammo.ts'
import { COLLISION } from '../../../../src/experiments/out-west/runtime/collision.ts'
import { createFrontierSimulation } from '../../../../src/experiments/out-west/runtime/frontier.ts'
import type { CollisionData } from '../../../../src/experiments/out-west/runtime/protocol.ts'

let ready: Promise<unknown> | undefined
const simulations: ReturnType<typeof createFrontierSimulation>[] = []
afterEach(() => {
  for (const simulation of simulations.splice(0)) {
    simulation.dispose()
  }
})
export async function nativeWorld(
  collision: CollisionData = COLLISION,
  options: WorldOptions = {},
) {
  ready ??= file(
    new URL('../../../../public/experiments/out-west/physics/ammo.wasm.wasm', import.meta.url),
  )
    .arrayBuffer()
    .then(WebAssembly.compile)
    .then(initializeAmmo)
  const simulation = createFrontierSimulation({ ammo: await ready, collision, seed: 7, ...options })
  simulations.push(simulation)
  simulation.world.nextStrongboxTick = 1_000_000
  return simulation
}
export async function nativeTestWorld(options: WorldOptions = {}) {
  return (await nativeWorld(COLLISION, options)).world
}
