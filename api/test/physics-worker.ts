import physicsModule from '../../public/experiments/out-west/physics/ammo.wasm.wasm'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'
import callbackModule from '../src/game/physics-callback.wasm'
export default {
  async fetch() {
    const ammo = await initializeAmmo(physicsModule, callbackModule)
    const collision = {
      version: 'test',
      boxes: [{ center: [0, -0.5, 0] as const, halfExtents: [20, 0.5, 20] as const }],
      meshes: [],
    }
    const a = createSimulation({ ammo, collision })
    const b = createSimulation({ ammo, collision })
    try {
      a.addPlayer('one', [0, 3, 0])
      b.addPlayer('two', [4, 4, 0])
      for (let i = 0; i < 60; i++) {
        a.step(new Map())
        b.step(new Map())
      }
      const one = { ...a.players.get('one') }
      a.dispose()
      for (let i = 0; i < 10; i++) {
        b.step(new Map())
      }
      return Response.json({ one, two: b.players.get('two') })
    } finally {
      a.dispose()
      b.dispose()
    }
  },
}
