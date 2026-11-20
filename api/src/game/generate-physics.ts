/** Copy the installed runtime's Ammo binary to the browser asset path. */
import { copyFile } from 'node:fs/promises'

await copyFile(
  new URL(import.meta.resolve('colyseus-cloudflare/ammo.wasm')),
  'public/experiments/out-west/physics/ammo.wasm.wasm',
)
