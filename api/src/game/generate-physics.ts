/** Reproduce the shared Ammo assets and update the browser-served copy. */
import { copyFile } from 'node:fs/promises'
import '../../../packages/durable-game-runtime/generate-physics.ts'

await copyFile(
  'packages/durable-game-runtime/src/vendor/ammo.wasm.wasm',
  'public/experiments/out-west/physics/ammo.wasm.wasm',
)
