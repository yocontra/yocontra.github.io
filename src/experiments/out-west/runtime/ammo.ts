import { loadAmmo as loadAmmoFromUrl } from '../../../../packages/durable-game-runtime/src/ammo.ts'

export function loadAmmo(url = '/experiments/out-west/physics/ammo.wasm.wasm'): Promise<unknown> {
  return loadAmmoFromUrl(url)
}
