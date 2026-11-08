import AmmoFactory from './vendor/ammo-factory.ts'

let loaded: Promise<unknown> | undefined
/** The physics module is shared, while each application owns its Bullet world. */
export function initializeAmmo(
  module: WebAssembly.Module,
  callbackModule?: WebAssembly.Module,
): Promise<unknown> {
  if (loaded) {
    return loaded
  }
  const pending: Promise<unknown> = AmmoFactory.call(globalThis, {
    callbackModule,
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) {
      const instance = new WebAssembly.Instance(module, imports)
      receive(instance, module)
      return instance.exports
    },
  })
    .then((ammo: unknown) => {
      Object.assign(globalThis, { Ammo: ammo })
      return ammo
    })
    .catch((error: unknown) => {
      loaded = undefined
      throw error
    })
  loaded = pending
  return pending
}
export async function loadAmmo(
  url = '/experiments/out-west/physics/ammo.wasm.wasm',
): Promise<unknown> {
  if (loaded) {
    return loaded
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Physics download failed (${response.status})`)
  }
  return initializeAmmo(await WebAssembly.compile(await response.arrayBuffer()))
}
