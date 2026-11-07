/** Compile during loading. Failure preserves the existing JavaScript solver. */
let compiled: WebAssembly.Module | null = null
let pending: Promise<WebAssembly.Module | null> | null = null

function requestModule(signal: AbortSignal): Promise<WebAssembly.Module | null> {
  return Promise.resolve()
    .then(() => fetch(new URL('./ragdoll-gs.wasm', import.meta.url), { signal }))
    .then(async (response) => {
      if (!response.ok) {
        return null
      }
      return WebAssembly.compile(await response.arrayBuffer())
    })
    .catch(() => null)
}

export function loadGsKernel(): Promise<WebAssembly.Module | null> {
  if (compiled) {
    return Promise.resolve(compiled)
  }
  if (pending) {
    return pending
  }
  if (typeof WebAssembly === 'undefined') {
    return Promise.resolve(null)
  }
  pending = new Promise((resolve) => {
    const controller = new AbortController()
    let settled = false
    const finish = (module: WebAssembly.Module | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      compiled = module
      pending = null
      resolve(module)
    }
    const timer = setTimeout(() => {
      controller.abort()
      finish(null)
    }, 5000)
    // The deadline covers body decoding and compilation too. Late completion never commits.
    void requestModule(controller.signal).then(finish)
  })
  return pending
}
