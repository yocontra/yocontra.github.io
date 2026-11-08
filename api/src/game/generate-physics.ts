/** Reproduce the pinned engine's generated Ammo assets. Run: bun api/src/game/generate-physics.ts */
import { write } from 'bun'

const engine = 'https://raw.githubusercontent.com/playcanvas/engine/v2.23.3'
async function download(path: string) {
  const response = await fetch(`${engine}/${path}`)
  if (!response.ok) {
    throw new Error(`Physics source download failed: ${path}`)
  }
  return response
}
const upstream = await (await download('examples/assets/wasm/ammo/ammo.wasm.js')).text()
const nodeEnvironment =
  // biome-ignore lint/security/noSecrets: exact generated JavaScript pattern, not a credential
  'fa="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node'
// biome-ignore lint/security/noSecrets: exact generated JavaScript pattern, not a credential
const trampoline = 'new WebAssembly.Module(new Uint8Array(c))'
const footer = "if (typeof exports === 'object' && typeof module === 'object')"
if (
  !(
    upstream.includes(nodeEnvironment) &&
    upstream.includes(trampoline) &&
    upstream.includes(footer)
  )
) {
  throw new Error('Pinned generated Ammo layout changed')
}
const factory = upstream
  .slice(0, upstream.indexOf(footer))
  .replace(nodeEnvironment, 'fa=!1')
  // biome-ignore lint/security/noSecrets: generated Wasm callback expression, not a credential
  .replace(trampoline, 'b.callbackModule||new WebAssembly.Module(new Uint8Array(c))')
await write(
  'src/experiments/out-west/runtime/vendor/ammo-factory.ts',
  `// @ts-nocheck
// Generated from PlayCanvas engine v2.23.3; altered source. See README.md and AMMO-LICENSE.txt.
// Changes: web environment, ESM export, optional precompiled callback trampoline.
${factory}\nexport default Ammo\n`,
)
await write(
  'public/experiments/out-west/physics/ammo.wasm.wasm',
  await (await download('examples/assets/wasm/ammo/ammo.wasm.wasm')).arrayBuffer(),
)
// Emscripten addFunction trampoline: import e.f(i32,f32)->void and export it as f.
// Each JS callback gets its own Instance; table slots remain managed by Ammo.addFunction/removeFunction.
await write(
  'api/src/game/physics-callback.wasm',
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 2, 127, 125, 0, 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5,
    1, 1, 102, 0, 0,
  ]),
)
