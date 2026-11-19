import { initializeWorkerAmmo } from '../../packages/durable-game-runtime/src/worker-physics.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'
export default {
  async fetch() {
    const ammo = await initializeWorkerAmmo()
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
