import { initializeAmmo } from './ammo.ts'
import ammoModule from './vendor/ammo.wasm.wasm'
import callbackModule from './vendor/physics-callback.wasm'

/** Wrangler imports both Wasm files as precompiled modules. */
export function initializeWorkerAmmo(): Promise<unknown> {
  return initializeAmmo(ammoModule, callbackModule)
}
