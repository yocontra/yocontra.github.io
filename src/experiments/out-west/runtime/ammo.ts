import { loadAmmo as loadAmmoFromUrl } from 'colyseus-cloudflare/ammo'

export function loadAmmo(url = '/experiments/out-west/physics/ammo.wasm.wasm'): Promise<unknown> {
  return loadAmmoFromUrl(url)
}
