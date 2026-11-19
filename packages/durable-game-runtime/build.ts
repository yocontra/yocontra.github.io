import { copyFile } from 'node:fs/promises'

const vendorFiles = [
  'ammo.wasm.wasm',
  'physics-callback.wasm',
  'AMMO-LICENSE.txt',
  'PLAYCANVAS-LICENSE.txt',
]
await Promise.all(
  vendorFiles.map((name) =>
    copyFile(
      new URL(`./src/vendor/${name}`, import.meta.url),
      new URL(`./dist/vendor/${name}`, import.meta.url),
    ),
  ),
)
